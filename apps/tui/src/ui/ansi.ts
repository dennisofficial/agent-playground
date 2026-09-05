/**
 * A command speaks in escape sequences; a transcript row cannot.
 *
 * Test runners and git paint their output with SGR colours, and progress lines rewrite themselves
 * with carriage returns — both of which render as litter in a `<text>`. v1 strips rather than
 * interprets: the words survive, the colour codes do not.
 */

const SEQUENCE = /\x1B(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|[()][0-2]?|[@-Z\\-_])/g

export const stripAnsi = (text: string): string => text.replace(SEQUENCE, '').replace(/\r/g, '')
