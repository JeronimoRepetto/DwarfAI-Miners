// Kernel driven port (05 §3, 16 §3): every surrogate id and EventId (09 §2, 08 §1.2).
export interface IdGenerator {
  uuidv7(): string
}
