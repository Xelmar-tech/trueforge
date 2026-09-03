/**
 * Rows a list query may return: those the caller created, unioned with those
 * bound to an agent the caller may see. Unlike the sibling list filters, which
 * intersect, these two halves are ORed.
 *
 * `agents: { kind: 'all' }` covers every agent-bound row but still excludes
 * rows with no agent that the caller does not own.
 */
export interface ListVisibility {
  owner_subject_id: string;
  agents: { kind: 'all' } | { kind: 'ids'; ids: readonly string[] };
}
