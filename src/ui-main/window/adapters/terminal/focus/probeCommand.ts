// One command a POSIX focus probe runs, as argv (never through a shell): transplanted for ISSUE-170
// from `src/main/platform/processProbe.ts` (`ProbeCommand`), the one type posixFocus.ts needs of it.
export interface ProbeCommand {
  command: string
  args: string[]
  /**
   * What to write to the child's standard input, for a command that reads its
   * payload there rather than from its argv (#471).
   *
   * Absent for every probe — a `ps` or an `osascript -e` has nothing to read —
   * and present for `tmux load-buffer -`, which is the one command on this path
   * carrying a person's whole message. It goes through stdin precisely so it
   * never touches an argv: this project has met that ceiling twice (#433, #437)
   * and an ordinary long message would meet it here.
   *
   * A runner that ignores this field would send the command with an EMPTY
   * payload rather than fail, so every runner that may be handed one must
   * write it and close the stream.
   */
  stdin?: string
}
