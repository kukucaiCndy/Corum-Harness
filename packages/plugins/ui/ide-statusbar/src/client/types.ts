/**
 * Shared wire types for the statusbar plugin: the host-description source the
 * shell's client provides on ctx.connection.hostDescription. Kept local to the
 * plugin so the component file compiles without importing the shell's client.
 */

/** Observable Host description published by each completed connection handshake. */
export interface CorumHostDescriptionSource {
  /** Latest connected-generation description; absent before connect/reconnect. */
  getSnapshot(): unknown
  /** Subscribe to description replacement and connection loss. */
  subscribe(listener: () => void): () => void
}
