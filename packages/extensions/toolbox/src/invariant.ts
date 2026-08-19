/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-toolbox`.
 * @module @deepseek-ai/dsh-toolbox/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-toolbox'

/** Cordis companion plugin name. */
export const name = 'toolbox-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the toolbox is a standalone JSONL file folded on read;
 * it owns no session event stream relation, and every read validates the
 * durable JSON boundary itself.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
