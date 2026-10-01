// SPDX-License-Identifier: GPL-3.0-or-later
//
// The UI's launch helper (ADR-002 D6 item 1; spike SP-02), as a Node-API module for Windows. It
// is loaded only by nativeWinLaunch.ts in this folder, in UI main, and starts the DwarfAI Host
// outside every job object the UI may be in, without a console window, from inside the UI process:
// no PowerShell or compiler process stands between them (windows.ts).
//
// breakaway() follows SP-02's recorded steps:
//   1. CreateProcessW with the caller's flags (CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT |
//      CREATE_BREAKAWAY_FROM_JOB | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW), no inherited
//      handles (clean stdio), the given environment block and working folder.
//      ERROR_ACCESS_DENIED (the job forbids breakaway) is a refusal.
//   2. IsProcessInJob on the suspended child: in nested jobs breakaway can succeed yet leave the
//      child in the UI's job (SP-02 finding 2). Still in a job counts as refused: the child is
//      ended before it ever ran.
//   3. Otherwise the child is resumed, and its process handle is kept for the exit watch.
// DETACHED_PROCESS is refused (D6 item 3), and so is a create that is not suspended, without which
// step 2 could not be done before the child runs.
//
// JavaScript surface:
//   breakaway(file, commandLine, cwd, environment, flags)
//     → { status: 'launched', process | null } | { status: 'refused' | 'failed', code: string }
//     (process is null only when its handle could not be wrapped: the Host runs, unwatched)
//     codes: CREATE_<win32 error>, STILL_IN_JOB, RESUME_<win32 error>. Throws a TypeError for bad
//     arguments or forbidden flags.
//   open(pid) → process | null: SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, enough to wait for
//     a WMI-created Host and read its exit code.
//   watch(process, ms, onExit(code)): calls onExit once, with the exit code (0 … 2^32-1) when the
//     process exits within ms, or -1 when it still runs then (-2: the exit code could not be read).
//     The Windows thread pool waits; the result reaches JavaScript through a thread-safe function
//     that never keeps the event loop alive.
//   release(process): ends the watch (onExit is not called afterwards) and closes the handle. The
//     process itself runs on. A handle that is collected without release() is released then.
//
// The static C runtime (/MT) keeps the binary free of any VC++ redistributable (the build's import
// check proves it); it imports kernel32 only.
#define WIN32_LEAN_AND_MEAN
#define UNICODE
#include <windows.h>
// delayimp.h uses an unnamed union (C4201), which /W4 /WX would refuse.
#pragma warning(push)
#pragma warning(disable : 4201)
#include <delayimp.h>
#pragma warning(pop)
#include <stdio.h>
#include <stdlib.h>

#include <node_api.h>

// ---- the host executable --------------------------------------------------------------------

// The import library names node.exe; under Electron the host executable has another name, so the
// delayed load of node.exe is answered with the running executable itself (the usual Node-API
// arrangement for native modules on Windows).
static FARPROC WINAPI load_host_executable(unsigned int event, DelayLoadInfo *info) {
  if (event == dliNotePreLoadLibrary && _stricmp(info->szDll, "node.exe") == 0)
    return (FARPROC)GetModuleHandleW(NULL);
  return NULL;
}
const PfnDliHook __pfnDliNotifyHook2 = load_host_executable;

// ---- a watched process ----------------------------------------------------------------------

typedef struct HostProcess {
  HANDLE process;
  // The thread pool's wait while watch() runs; NULL otherwise.
  HANDLE wait;
  // The onExit function while watch() runs; NULL once released.
  napi_threadsafe_function exited;
  // Set by the thread pool when the wait fired; read after the wait is unregistered.
  volatile LONG fired;
  BOOLEAN timed_out;
  BOOL released;
  // One reference for the JavaScript object, one for the thread-safe function while it exists.
  int references;
} HostProcess;

static void unreference(HostProcess *host) {
  if (--host->references > 0) return;
  free(host);
}

// Ends the watch and closes the handle, once. JavaScript thread only.
static void release_host(HostProcess *host) {
  if (host->released) return;
  host->released = TRUE;
  if (host->wait != NULL) {
    // Waits for a callback that is running; afterwards `fired` no longer changes.
    UnregisterWaitEx(host->wait, INVALID_HANDLE_VALUE);
    host->wait = NULL;
  }
  // A fired wait is already queued: on_exit_reported releases the function after it ran.
  if (host->exited != NULL && InterlockedCompareExchange(&host->fired, 0, 0) == 0) {
    napi_release_threadsafe_function(host->exited, napi_tsfn_release);
    host->exited = NULL;
  }
  CloseHandle(host->process);
  host->process = NULL;
}

// Thread pool: the process exited, or the watch's time ran out.
static VOID CALLBACK on_wait_fired(PVOID context, BOOLEAN timed_out) {
  HostProcess *host = context;
  host->timed_out = timed_out;
  InterlockedExchange(&host->fired, 1);
  // Never fails here: the queue is unbounded, and release_host unregisters the wait before it
  // releases the function.
  napi_call_threadsafe_function(host->exited, host, napi_tsfn_nonblocking);
}

// JavaScript thread: report the exit to onExit, unless released meanwhile.
static void on_exit_reported(napi_env env, napi_value on_exit, void *context, void *data) {
  HostProcess *host = data;
  (void)context;
  if (host->wait != NULL) {
    UnregisterWaitEx(host->wait, INVALID_HANDLE_VALUE);
    host->wait = NULL;
  }
  napi_threadsafe_function exited = host->exited;
  if (env != NULL && !host->released) {
    double code = -1;
    DWORD exit_code;
    if (!host->timed_out) code = GetExitCodeProcess(host->process, &exit_code) ? exit_code : -2;
    napi_value undefined, argv[1];
    napi_get_undefined(env, &undefined);
    napi_create_double(env, code, &argv[0]);
    napi_call_function(env, undefined, on_exit, 1, argv, NULL);
  }
  // onExit may have released the process; the function is this call's to release either way.
  host->exited = NULL;
  if (exited != NULL) napi_release_threadsafe_function(exited, napi_tsfn_release);
}

static void on_exited_finalized(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  unreference(data);
}

static void on_host_collected(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  release_host(data);
  unreference(data);
}

// The JavaScript object for a process handle this module now owns, or NULL (handle closed).
static napi_value wrap_process(napi_env env, HANDLE process) {
  HostProcess *host = calloc(1, sizeof *host);
  napi_value object;
  if (host == NULL) {
    CloseHandle(process);
    return NULL;
  }
  host->process = process;
  host->references = 1;
  if (napi_create_external(env, host, on_host_collected, NULL, &object) != napi_ok) {
    CloseHandle(process);
    free(host);
    return NULL;
  }
  return object;
}

static HostProcess *unwrap_process(napi_env env, napi_value value) {
  void *host = NULL;
  napi_valuetype type;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_external ||
      napi_get_value_external(env, value, &host) != napi_ok)
    return NULL;
  return host;
}

// ---- arguments --------------------------------------------------------------------------------

// A JavaScript string as a NUL-terminated UTF-16 copy (embedded NULs kept); the caller frees it.
static wchar_t *string_argument(napi_env env, napi_value value) {
  napi_valuetype type;
  size_t length;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string ||
      napi_get_value_string_utf16(env, value, NULL, 0, &length) != napi_ok)
    return NULL;
  wchar_t *text = calloc(length + 1, sizeof(wchar_t));
  if (text == NULL) return NULL;
  napi_get_value_string_utf16(env, value, (char16_t *)text, length + 1, &length);
  return text;
}

static napi_value result_object(napi_env env, const char *status, const char *code,
                                napi_value process) {
  napi_value result, value;
  napi_create_object(env, &result);
  napi_create_string_utf8(env, status, NAPI_AUTO_LENGTH, &value);
  napi_set_named_property(env, result, "status", value);
  if (code != NULL) {
    napi_create_string_utf8(env, code, NAPI_AUTO_LENGTH, &value);
    napi_set_named_property(env, result, "code", value);
  }
  if (process != NULL) napi_set_named_property(env, result, "process", process);
  return result;
}

static napi_value win32_result(napi_env env, const char *status, const char *what, DWORD error) {
  char code[32];
  snprintf(code, sizeof code, "%s_%lu", what, (unsigned long)error);
  return result_object(env, status, code, NULL);
}

// ---- breakaway --------------------------------------------------------------------------------

static napi_value breakaway(napi_env env, const wchar_t *file, wchar_t *command_line,
                            const wchar_t *cwd, wchar_t *environment, DWORD flags) {
  STARTUPINFOW startup = {0};
  PROCESS_INFORMATION created;
  startup.cb = sizeof startup;
  if (!CreateProcessW(file, command_line, NULL, NULL, FALSE, flags, environment, cwd, &startup,
                      &created)) {
    DWORD error = GetLastError();
    return win32_result(env, error == ERROR_ACCESS_DENIED ? "refused" : "failed", "CREATE", error);
  }
  BOOL in_job = TRUE;
  if (!IsProcessInJob(created.hProcess, NULL, &in_job) || in_job) {
    TerminateProcess(created.hProcess, 1);
    CloseHandle(created.hThread);
    CloseHandle(created.hProcess);
    return result_object(env, "refused", "STILL_IN_JOB", NULL);
  }
  if (ResumeThread(created.hThread) == (DWORD)-1) {
    DWORD error = GetLastError();
    TerminateProcess(created.hProcess, 1);
    CloseHandle(created.hThread);
    CloseHandle(created.hProcess);
    return win32_result(env, "failed", "RESUME", error);
  }
  CloseHandle(created.hThread);
  napi_value process = wrap_process(env, created.hProcess);
  // Out of memory: the Host runs but cannot be watched (process: null); the launcher still sees
  // it through its endpoint.
  if (process == NULL) napi_get_null(env, &process);
  return result_object(env, "launched", NULL, process);
}

static napi_value js_breakaway(napi_env env, napi_callback_info info) {
  size_t argc = 5;
  napi_value argv[5];
  uint32_t flags = 0;
  napi_valuetype flags_type;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 5 ||
      napi_typeof(env, argv[4], &flags_type) != napi_ok || flags_type != napi_number ||
      napi_get_value_uint32(env, argv[4], &flags) != napi_ok) {
    napi_throw_type_error(env, NULL,
                          "breakaway(file, commandLine, cwd, environment: string, flags: number)");
    return NULL;
  }
  if ((flags & DETACHED_PROCESS) != 0 || (flags & CREATE_SUSPENDED) == 0) {
    napi_throw_type_error(env, NULL,
                          "breakaway: flags must hold CREATE_SUSPENDED and never DETACHED_PROCESS");
    return NULL;
  }
  wchar_t *strings[4] = {NULL, NULL, NULL, NULL};
  BOOL complete = TRUE;
  for (int index = 0; index < 4; index++) {
    strings[index] = string_argument(env, argv[index]);
    if (strings[index] == NULL) complete = FALSE;
  }
  napi_value result = NULL;
  if (complete) result = breakaway(env, strings[0], strings[1], strings[2], strings[3], flags);
  else napi_throw_type_error(env, NULL, "breakaway: file, commandLine, cwd, environment: string");
  for (int index = 0; index < 4; index++) free(strings[index]);
  return result;
}

// ---- open, watch, release -----------------------------------------------------------------------

static napi_value js_open(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  uint32_t pid = 0;
  napi_valuetype type;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1 ||
      napi_typeof(env, argv[0], &type) != napi_ok || type != napi_number ||
      napi_get_value_uint32(env, argv[0], &pid) != napi_ok) {
    napi_throw_type_error(env, NULL, "open(pid: number)");
    return NULL;
  }
  HANDLE process = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  napi_value result = process == NULL ? NULL : wrap_process(env, process);
  if (result == NULL) napi_get_null(env, &result);
  return result;
}

static napi_value js_watch(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  uint32_t ms = 0;
  napi_valuetype ms_type, callback_type;
  HostProcess *host = NULL;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 3 ||
      (host = unwrap_process(env, argv[0])) == NULL ||
      napi_typeof(env, argv[1], &ms_type) != napi_ok || ms_type != napi_number ||
      napi_get_value_uint32(env, argv[1], &ms) != napi_ok ||
      napi_typeof(env, argv[2], &callback_type) != napi_ok || callback_type != napi_function) {
    napi_throw_type_error(env, NULL, "watch(process, ms: number, onExit: function)");
    return NULL;
  }
  if (host->released || host->exited != NULL || host->fired != 0) {
    napi_throw_error(env, "WATCH_STATE", "watch: the process is released or already watched");
    return NULL;
  }
  napi_value resource;
  napi_create_string_utf8(env, "dwarfai.winLaunch", NAPI_AUTO_LENGTH, &resource);
  if (napi_create_threadsafe_function(env, argv[2], NULL, resource, 0, 1, host, on_exited_finalized,
                                      NULL, on_exit_reported, &host->exited) != napi_ok) {
    host->exited = NULL;
    napi_throw_error(env, "WATCH_FAILED", "watch: the exit function could not be created");
    return NULL;
  }
  host->references++;
  // The watch is advisory: it never keeps the UI's event loop alive.
  napi_unref_threadsafe_function(env, host->exited);
  if (!RegisterWaitForSingleObject(&host->wait, host->process, on_wait_fired, host, ms,
                                   WT_EXECUTEONLYONCE)) {
    char code[32];
    snprintf(code, sizeof code, "WIN32_%lu", (unsigned long)GetLastError());
    host->wait = NULL;
    napi_release_threadsafe_function(host->exited, napi_tsfn_release);
    host->exited = NULL;
    napi_throw_error(env, code, "watch: RegisterWaitForSingleObject failed");
    return NULL;
  }
  return NULL;
}

static napi_value js_release(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  HostProcess *host = NULL;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1 ||
      (host = unwrap_process(env, argv[0])) == NULL) {
    napi_throw_type_error(env, NULL, "release(process)");
    return NULL;
  }
  release_host(host);
  return NULL;
}

NAPI_MODULE_INIT(/* napi_env env, napi_value exports */) {
  napi_value function;
  napi_create_function(env, "breakaway", NAPI_AUTO_LENGTH, js_breakaway, NULL, &function);
  napi_set_named_property(env, exports, "breakaway", function);
  napi_create_function(env, "open", NAPI_AUTO_LENGTH, js_open, NULL, &function);
  napi_set_named_property(env, exports, "open", function);
  napi_create_function(env, "watch", NAPI_AUTO_LENGTH, js_watch, NULL, &function);
  napi_set_named_property(env, exports, "watch", function);
  napi_create_function(env, "release", NAPI_AUTO_LENGTH, js_release, NULL, &function);
  napi_set_named_property(env, exports, "release", function);
  return exports;
}
