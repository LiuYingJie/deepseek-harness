/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-tool-toolbox`.
 * @module @deepseek-ai/dsh-tool-toolbox/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-toolbox'

/** Cordis companion plugin name. */
export const name = 'tool-toolbox-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the mount registers plain tools whose execute resolves
 * through `ctx.toolbox` at call time; the library file validates its own durable
 * JSON boundary on every read, and no session event stream relation exists.
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
