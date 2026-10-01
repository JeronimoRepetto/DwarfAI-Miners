// SPDX-License-Identifier: GPL-3.0-or-later
//
// The DwarfAI Host's owner-only named pipe (ADR-003 item 2, frozen; spike SP-05), as a Node-API
// module for Windows. It is loaded only by nativeOwnerOnlyPipe.ts in this folder.
//
// Every instance of the pipe is created with the protected DACL
//   D:P(D;;GA;;;NU)(A;;GA;;;<user SID>)(A;;GA;;;SY)
// (the user SID is the one of this process's token) and with PIPE_REJECT_REMOTE_CLIENTS, the first
// instance with FILE_FLAG_FIRST_PIPE_INSTANCE so that the bind is the Host's single-instance mutex
// (ADR-002 D3). The design of the DACL follows observer (Apache-2.0,
// internal/attachsock/transport_windows.go), as ADR-003 records; no code is copied from it.
//
// Accepting: PENDING_INSTANCES instances wait in an overlapped ConnectNamedPipe; the Windows thread
// pool waits on each one's event and posts the completion to the JavaScript thread through a
// thread-safe function. There the connected pipe becomes a C runtime descriptor of the host
// executable (libuv's uv_open_osfhandle, which node.exe and Electron export; resolved at load time,
// so a host without it fails to load this module instead of misbehaving), a fresh instance takes
// its place, and JavaScript receives the descriptor, which it opens as a net.Socket. From then on
// libuv owns the handle: Node does every read, write and close.
//
// JavaScript surface:
//   listen(name: string, onEvent: (error: number, fd: number) => void): object
//     throws an Error whose code is "WIN32_<n>" when the first instance cannot be created
//     (ERROR_ACCESS_DENIED: the name already has an instance).
//     onEvent(0, fd): a client connected; onEvent(error, -1): accepting failed with that Win32 error.
//   close(listener: object): void
//     closes the waiting instances; descriptors already handed over are not touched.
//   protectDirectory(path: string): boolean
//     gives the directory the protected DACL D:P(A;OICI;FA;;;<user SID>)(A;OICI;FA;;;SY) (the SP-05
//     run\ row), propagated to what it holds; true when applied, false when it was already in
//     place; throws "WIN32_<n>" when it cannot be applied (ISSUE-041 amendment, 2026-10-01).
//
// The listener keeps the event loop alive until it is closed. The static C runtime (/MT) keeps the
// binary free of any VC++ redistributable (the build's import check proves it).
#define WIN32_LEAN_AND_MEAN
#define UNICODE
#include <windows.h>
// delayimp.h uses an unnamed union (C4201), which /W4 /WX would refuse.
#pragma warning(push)
#pragma warning(disable : 4201)
#include <delayimp.h>
#pragma warning(pop)
#include <aclapi.h>
#include <sddl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

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

// int uv_open_osfhandle(uv_os_fd_t os_fd); uv_os_fd_t is a HANDLE on Windows (libuv >= 1.23).
typedef int (*open_osfhandle_fn)(HANDLE);
static open_osfhandle_fn open_osfhandle;

// ---- the listener ---------------------------------------------------------------------------

// How many instances wait for a client at once (libuv's own default for a pipe server).
#define PENDING_INSTANCES 4
// The pipe's buffer sizes, libuv's.
#define PIPE_BUFFER_BYTES 65536
// The frozen DACL of ADR-003 item 2; %s is the user SID.
#define OWNER_ONLY_SDDL L"D:P(D;;GA;;;NU)(A;;GA;;;%s)(A;;GA;;;SY)"

typedef struct Listener Listener;

typedef struct Instance {
  Listener *owner;
  HANDLE pipe;
  HANDLE event;
  HANDLE wait;
  OVERLAPPED overlapped;
  // The client was already connected when ConnectNamedPipe was called.
  BOOL connected_at_once;
  // Set by the thread pool when the wait fired; read after the wait is unregistered.
  volatile LONG fired;
  struct Instance *next;
} Instance;

struct Listener {
  wchar_t *name;
  PSECURITY_DESCRIPTOR security;
  napi_threadsafe_function completions;
  Instance *waiting;
  int waiting_count;
  BOOL closed;
  // One reference for the JavaScript object, one for the thread-safe function.
  int references;
};

static void release_listener(Listener *listener) {
  if (--listener->references > 0) return;
  LocalFree(listener->security);
  free(listener->name);
  free(listener);
}

static void discard_instance(Instance *instance) {
  CancelIoEx(instance->pipe, &instance->overlapped);
  CloseHandle(instance->pipe);
  CloseHandle(instance->event);
  free(instance);
}

// Thread pool: the instance's connect completed (or the instance is being closed).
static VOID CALLBACK on_connect_signalled(PVOID context, BOOLEAN timed_out) {
  Instance *instance = context;
  (void)timed_out;
  InterlockedExchange(&instance->fired, 1);
  // Never fails here: the queue is unbounded, and close() unregisters every wait before it
  // releases the function.
  napi_call_threadsafe_function(instance->owner->completions, instance, napi_tsfn_nonblocking);
}

// Creates one instance and starts waiting for its client. Returns 0 or a Win32 error.
static DWORD start_instance(Listener *listener, BOOL first) {
  SECURITY_ATTRIBUTES attributes = {sizeof attributes, listener->security, FALSE};
  DWORD open_mode = PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED;
  if (first) open_mode |= FILE_FLAG_FIRST_PIPE_INSTANCE;
  DWORD pipe_mode = PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS;
  HANDLE pipe = CreateNamedPipeW(listener->name, open_mode, pipe_mode, PIPE_UNLIMITED_INSTANCES,
                                 PIPE_BUFFER_BYTES, PIPE_BUFFER_BYTES, 0, &attributes);
  if (pipe == INVALID_HANDLE_VALUE) return GetLastError();
  Instance *instance = calloc(1, sizeof *instance);
  HANDLE event = CreateEventW(NULL, TRUE, FALSE, NULL);
  if (instance == NULL || event == NULL) {
    DWORD error = instance == NULL ? ERROR_NOT_ENOUGH_MEMORY : GetLastError();
    if (event != NULL) CloseHandle(event);
    free(instance);
    CloseHandle(pipe);
    return error;
  }
  instance->owner = listener;
  instance->pipe = pipe;
  instance->event = event;
  instance->overlapped.hEvent = event;
  if (ConnectNamedPipe(pipe, &instance->overlapped)) {
    // An overlapped connect does not complete synchronously; treat it as connected if it does.
    instance->connected_at_once = TRUE;
    SetEvent(event);
  } else {
    DWORD error = GetLastError();
    if (error == ERROR_PIPE_CONNECTED) {
      instance->connected_at_once = TRUE;
      SetEvent(event);
    } else if (error != ERROR_IO_PENDING) {
      discard_instance(instance);
      return error;
    }
  }
  if (!RegisterWaitForSingleObject(&instance->wait, event, on_connect_signalled, instance, INFINITE,
                                   WT_EXECUTEONLYONCE)) {
    DWORD error = GetLastError();
    discard_instance(instance);
    return error;
  }
  instance->next = listener->waiting;
  listener->waiting = instance;
  listener->waiting_count++;
  return 0;
}

static void unlink_instance(Listener *listener, Instance *instance) {
  for (Instance **link = &listener->waiting; *link != NULL; link = &(*link)->next) {
    if (*link == instance) {
      *link = instance->next;
      listener->waiting_count--;
      return;
    }
  }
}

static void report(napi_env env, napi_value on_event, DWORD error, int fd) {
  napi_value undefined, argv[2];
  napi_get_undefined(env, &undefined);
  napi_create_int32(env, (int32_t)error, &argv[0]);
  napi_create_int32(env, fd, &argv[1]);
  napi_call_function(env, undefined, on_event, 2, argv, NULL);
}

// JavaScript thread: one instance's wait fired.
static void on_completion(napi_env env, napi_value on_event, void *context, void *data) {
  Instance *instance = data;
  Listener *listener = instance->owner;
  (void)context;
  if (instance->wait != NULL) UnregisterWaitEx(instance->wait, INVALID_HANDLE_VALUE);
  instance->wait = NULL;
  unlink_instance(listener, instance);
  // Closed meanwhile, or the environment is going away: the instance is only discarded.
  if (env == NULL || listener->closed) {
    discard_instance(instance);
    return;
  }

  DWORD transferred, error = 0;
  int fd = -1;
  if (instance->connected_at_once ||
      GetOverlappedResult(instance->pipe, &instance->overlapped, &transferred, FALSE)) {
    fd = open_osfhandle(instance->pipe);
    if (fd < 0) error = ERROR_INVALID_HANDLE;
  } else {
    error = GetLastError();
  }
  if (fd < 0) CloseHandle(instance->pipe);
  CloseHandle(instance->event);
  free(instance);

  // A fresh instance takes the place of the one that connected.
  DWORD refill = 0;
  while (refill == 0 && listener->waiting_count < PENDING_INSTANCES)
    refill = start_instance(listener, FALSE);

  if (fd >= 0) report(env, on_event, 0, fd);
  else if (error != ERROR_OPERATION_ABORTED) report(env, on_event, error, -1);
  if (refill != 0 && !listener->closed) report(env, on_event, refill, -1);
}

static void on_completions_finalized(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  release_listener(data);
}

static void close_listener(Listener *listener) {
  if (listener->closed) return;
  listener->closed = TRUE;
  Instance *instance = listener->waiting;
  listener->waiting = NULL;
  listener->waiting_count = 0;
  while (instance != NULL) {
    Instance *next = instance->next;
    // Waits for a callback that is running; afterwards `fired` no longer changes.
    UnregisterWaitEx(instance->wait, INVALID_HANDLE_VALUE);
    instance->wait = NULL;
    // A fired instance is already queued: on_completion discards it.
    if (InterlockedCompareExchange(&instance->fired, 0, 0) == 0) discard_instance(instance);
    instance = next;
  }
  napi_release_threadsafe_function(listener->completions, napi_tsfn_release);
}

static void on_listener_collected(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  close_listener(data);
  release_listener(data);
}

// This process's user SID as a string; the caller LocalFree()s it. Returns 0 or a Win32 error.
static DWORD current_user_sid(wchar_t **sid) {
  HANDLE token;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return GetLastError();
  DWORD size = 0, error = 0;
  GetTokenInformation(token, TokenUser, NULL, 0, &size);
  TOKEN_USER *user = size > 0 ? malloc(size) : NULL;
  if (user == NULL) error = ERROR_NOT_ENOUGH_MEMORY;
  else if (!GetTokenInformation(token, TokenUser, user, size, &size) ||
           !ConvertSidToStringSidW(user->User.Sid, sid))
    error = GetLastError();
  free(user);
  CloseHandle(token);
  return error;
}

// `format` (one %s: the user SID) for this process's user, converted. Returns 0 or a Win32 error.
static DWORD security_for_user(const wchar_t *format, PSECURITY_DESCRIPTOR *security) {
  wchar_t *sid = NULL;
  DWORD error = current_user_sid(&sid);
  if (error != 0) return error;
  wchar_t sddl[256];
  int length = _snwprintf_s(sddl, _countof(sddl), _TRUNCATE, format, sid);
  LocalFree(sid);
  if (length < 0) return ERROR_INSUFFICIENT_BUFFER;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, SDDL_REVISION_1, security, NULL))
    return GetLastError();
  return 0;
}

// The SDDL of ADR-003 item 2 for this process's user, converted. Returns 0 or a Win32 error.
static DWORD owner_only_security(PSECURITY_DESCRIPTOR *security) {
  return security_for_user(OWNER_ONLY_SDDL, security);
}

static napi_value throw_win32(napi_env env, DWORD error, const char *what) {
  char code[24];
  snprintf(code, sizeof code, "WIN32_%lu", (unsigned long)error);
  napi_throw_error(env, code, what);
  return NULL;
}

static napi_value js_listen(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_valuetype name_type, callback_type;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 2 ||
      napi_typeof(env, argv[0], &name_type) != napi_ok || name_type != napi_string ||
      napi_typeof(env, argv[1], &callback_type) != napi_ok || callback_type != napi_function) {
    napi_throw_type_error(env, NULL, "listen(name: string, onEvent: function)");
    return NULL;
  }
  size_t length;
  napi_get_value_string_utf16(env, argv[0], NULL, 0, &length);
  Listener *listener = calloc(1, sizeof *listener);
  if (listener == NULL) return throw_win32(env, ERROR_NOT_ENOUGH_MEMORY, "out of memory");
  listener->name = calloc(length + 1, sizeof(wchar_t));
  if (listener->name == NULL) {
    free(listener);
    return throw_win32(env, ERROR_NOT_ENOUGH_MEMORY, "out of memory");
  }
  napi_get_value_string_utf16(env, argv[0], (char16_t *)listener->name, length + 1, &length);
  DWORD error = owner_only_security(&listener->security);
  if (error != 0) {
    free(listener->name);
    free(listener);
    return throw_win32(env, error, "the owner-only security descriptor could not be built");
  }
  listener->references = 2;
  napi_value resource;
  napi_create_string_utf8(env, "dwarfai.winPipe", NAPI_AUTO_LENGTH, &resource);
  if (napi_create_threadsafe_function(env, argv[1], NULL, resource, 0, 1, listener,
                                      on_completions_finalized, NULL, on_completion,
                                      &listener->completions) != napi_ok) {
    LocalFree(listener->security);
    free(listener->name);
    free(listener);
    return throw_win32(env, ERROR_INVALID_FUNCTION, "the completion function could not be created");
  }
  error = start_instance(listener, TRUE);
  for (int count = 1; error == 0 && count < PENDING_INSTANCES; count++)
    error = start_instance(listener, FALSE);
  if (error != 0) {
    close_listener(listener);
    release_listener(listener);
    return throw_win32(env, error, "CreateNamedPipeW failed");
  }
  napi_value handle;
  napi_create_external(env, listener, on_listener_collected, NULL, &handle);
  return handle;
}

static napi_value js_close(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  void *listener = NULL;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1 ||
      napi_get_value_external(env, argv[0], &listener) != napi_ok || listener == NULL) {
    napi_throw_type_error(env, NULL, "close(listener)");
    return NULL;
  }
  close_listener(listener);
  return NULL;
}

// ---- the owner-only data directory ------------------------------------------------------------

// The SP-05 run\ row: owner and SYSTEM, full access, inherited by files and folders, protected
// (nothing is inherited from the parent); %s is the user SID. Owner-approved amendment (2026-10-01,
// ISSUE-041): protected owner-only DACL on the Windows data directory (SP-05 run\ row), replacing
// 09 §9's inherited profile ACL.
#define OWNER_ONLY_DIRECTORY_SDDL L"D:P(A;OICI;FA;;;%s)(A;OICI;FA;;;SY)"

// True when both ACLs hold the same entries in the same order, byte for byte.
static BOOL same_entries(PACL a, PACL b) {
  if (a == NULL || b == NULL || a->AceCount != b->AceCount) return FALSE;
  for (WORD index = 0; index < a->AceCount; index++) {
    ACE_HEADER *left, *right;
    if (!GetAce(a, index, (LPVOID *)&left) || !GetAce(b, index, (LPVOID *)&right)) return FALSE;
    if (left->AceSize != right->AceSize || memcmp(left, right, left->AceSize) != 0) return FALSE;
  }
  return TRUE;
}

// Gives `path` the owner-only directory DACL unless it already has it. SetNamedSecurityInfoW
// propagates the inheritable entries to everything the directory already holds (their inherited
// entries are replaced). Sets *repaired; returns 0 or a Win32 error.
static DWORD protect_directory(const wchar_t *path, BOOL *repaired) {
  PSECURITY_DESCRIPTOR wanted = NULL, current = NULL;
  PACL wanted_dacl = NULL, current_dacl = NULL;
  BOOL present = FALSE, defaulted = FALSE;
  *repaired = FALSE;
  DWORD error = security_for_user(OWNER_ONLY_DIRECTORY_SDDL, &wanted);
  if (error != 0) return error;
  if (!GetSecurityDescriptorDacl(wanted, &present, &wanted_dacl, &defaulted) || !present) {
    error = present ? GetLastError() : ERROR_INVALID_SECURITY_DESCR;
    LocalFree(wanted);
    return error;
  }
  error = GetNamedSecurityInfoW(path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, NULL, NULL,
                                &current_dacl, NULL, &current);
  if (error == ERROR_SUCCESS) {
    SECURITY_DESCRIPTOR_CONTROL control = 0;
    DWORD revision = 0;
    BOOL in_place = GetSecurityDescriptorControl(current, &control, &revision) &&
                    (control & SE_DACL_PROTECTED) != 0 && same_entries(current_dacl, wanted_dacl);
    if (!in_place) {
      error = SetNamedSecurityInfoW((LPWSTR)path, SE_FILE_OBJECT,
                                    DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                                    NULL, NULL, wanted_dacl, NULL);
      if (error == ERROR_SUCCESS) *repaired = TRUE;
    }
  }
  LocalFree(current);
  LocalFree(wanted);
  return error == ERROR_SUCCESS ? 0 : error;
}

static napi_value js_protect_directory(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_valuetype path_type;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc != 1 ||
      napi_typeof(env, argv[0], &path_type) != napi_ok || path_type != napi_string) {
    napi_throw_type_error(env, NULL, "protectDirectory(path: string)");
    return NULL;
  }
  size_t length;
  napi_get_value_string_utf16(env, argv[0], NULL, 0, &length);
  wchar_t *path = calloc(length + 1, sizeof(wchar_t));
  if (path == NULL) return throw_win32(env, ERROR_NOT_ENOUGH_MEMORY, "out of memory");
  napi_get_value_string_utf16(env, argv[0], (char16_t *)path, length + 1, &length);
  BOOL repaired = FALSE;
  DWORD error = protect_directory(path, &repaired);
  free(path);
  if (error != 0) return throw_win32(env, error, "the owner-only directory DACL could not be applied");
  napi_value result;
  napi_get_boolean(env, repaired, &result);
  return result;
}

NAPI_MODULE_INIT(/* napi_env env, napi_value exports */) {
  open_osfhandle = (open_osfhandle_fn)(void *)GetProcAddress(GetModuleHandleW(NULL), "uv_open_osfhandle");
  if (open_osfhandle == NULL) {
    napi_throw_error(env, "WIN32_HOST_EXPORTS",
                     "the host executable does not export uv_open_osfhandle");
    return NULL;
  }
  napi_value function;
  napi_create_function(env, "listen", NAPI_AUTO_LENGTH, js_listen, NULL, &function);
  napi_set_named_property(env, exports, "listen", function);
  napi_create_function(env, "close", NAPI_AUTO_LENGTH, js_close, NULL, &function);
  napi_set_named_property(env, exports, "close", function);
  napi_create_function(env, "protectDirectory", NAPI_AUTO_LENGTH, js_protect_directory, NULL,
                       &function);
  napi_set_named_property(env, exports, "protectDirectory", function);
  return exports;
}
