/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-tool-refinery`.
 * @module @deepseek-ai/dsh-tool-refinery/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-refinery'

/** Cordis companion plugin name. */
export const name = 'tool-refinery-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the refinery tools persist through `ctx.refinery`,
 * whose own fold validates the durable JSON boundary; the tool registrations
 * unwind with the plugin fiber.
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
