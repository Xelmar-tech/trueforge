/**
 * Postgres historical session snapshot insert (skip-if-exists).
 */
import type { Kysely, RawBuilder } from 'kysely';
import { sql } from 'kysely';
import {
  isContextPrefix,
  type ImportSessionSnapshotInput,
  type ImportSessionSnapshotResult,
  type ISessionSnapshotImporter,
} from '../../sessionSnapshotImport';
import type { Database } from '../types';

function jsonbColumn<T>(value: unknown): RawBuilder<T> {
  return sql`${JSON.stringify(value)}::jsonb`;
}

export class PostgresSessionSnapshotImporter implements ISessionSnapshotImporter {
  constructor(private readonly db: Kysely<Database>) {}

  async importSessionSnapshot(input: ImportSessionSnapshotInput): Promise<ImportSessionSnapshotResult> {
    const sessionId = input.session.session_id;
    return this.db.transaction().execute(async trx => {
      const existing = await trx
        .selectFrom('session')
        .select('session_id')
        .where('session_id', '=', sessionId)
        .executeTakeFirst();
      if (existing !== undefined) {
        return { imported: false, session_id: sessionId };
      }

      const { session, turns } = input;
      await trx
        .insertInto('session')
        .values({
          tenant_id: session.tenant_id,
          session_id: sessionId,
          created_by: session.created_by,
          agent_id: null,
          agent_name: null,
          agent_spec: jsonbColumn(session.agent_spec),
          title: session.title,
          last_turn_id: session.last_turn_id,
          custom: session.custom !== null ? jsonbColumn(session.custom) : null,
          last_activity_timestamp_ms: session.last_activity_timestamp_ms,
          created_at: new Date(session.created_at),
          updated_at: new Date(session.updated_at),
        })
        .execute();

      const prevContextByThread = new Map<string, unknown[]>();
      const prevContextIdsByThread = new Map<string, number[]>();

      for (const turn of turns) {
        await trx
          .insertInto('turn')
          .values({
            session_id: sessionId,
            turn_id: turn.turn_id,
            first_turn_id: turn.first_turn_id,
            previous_turn_id: turn.previous_turn_id,
            ancestor_ids: turn.ancestor_ids,
            input: jsonbColumn(turn.input),
            state: jsonbColumn(turn.state),
            checkpoint: jsonbColumn(turn.checkpoint),
            custom: turn.custom !== null ? jsonbColumn(turn.custom) : null,
            created_at: new Date(turn.created_at),
            updated_at: new Date(turn.updated_at),
          })
          .execute();

        for (const thread of turn.threads) {
          const prevCtx = prevContextByThread.get(thread.thread_id) ?? [];
          const prevIds = prevContextIdsByThread.get(thread.thread_id) ?? [];
          const appendOnly = isContextPrefix(prevCtx, thread.context);
          const newMessages = appendOnly ? thread.context.slice(prevCtx.length) : thread.context;
          const reusedIds = appendOnly ? prevIds : [];

          const newIds: number[] = [];
          if (newMessages.length > 0) {
            const inserted = await trx
              .insertInto('thread_context_log')
              .values(
                newMessages.map(msg => ({
                  session_id: sessionId,
                  thread_id: thread.thread_id,
                  turn_id: turn.turn_id,
                  body: jsonbColumn(msg),
                  created_at: new Date(turn.updated_at),
                })),
              )
              .returning(['append_id'])
              .execute();
            for (const row of inserted) {
              newIds.push(row.append_id);
            }
          }

          const contextIds = [...reusedIds, ...newIds];
          await trx
            .insertInto('turn_thread')
            .values({
              session_id: sessionId,
              turn_id: turn.turn_id,
              thread_id: thread.thread_id,
              checkpoint: jsonbColumn({ parent: thread.parent, completion: thread.completion }),
              agent_info: thread.agent_info !== null ? jsonbColumn(thread.agent_info) : null,
              current_context_usage: jsonbColumn(thread.current_context_usage),
              context_ids: contextIds,
              updated_at: new Date(turn.updated_at),
            })
            .execute();

          prevContextByThread.set(thread.thread_id, thread.context);
          prevContextIdsByThread.set(thread.thread_id, contextIds);

          if (thread.capability_state !== null) {
            const capEntries = Object.entries(thread.capability_state);
            if (capEntries.length > 0) {
              await trx
                .insertInto('thread_capability_state')
                .values(
                  capEntries.map(([key, state]) => ({
                    session_id: sessionId,
                    turn_id: turn.turn_id,
                    thread_id: thread.thread_id,
                    key,
                    state: jsonbColumn(state),
                    updated_at: new Date(turn.updated_at),
                  })),
                )
                .execute();
            }
          }
        }

        if (turn.events.length > 0) {
          await trx
            .insertInto('session_event')
            .values(
              turn.events.map(event => ({
                session_id: sessionId,
                turn_id: turn.turn_id,
                event_id: event.id,
                event: jsonbColumn(event),
                created_at: new Date(event.created_at),
              })),
            )
            .execute();
        }
      }

      return { imported: true, session_id: sessionId };
    });
  }
}
