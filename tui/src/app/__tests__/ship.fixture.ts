import type { ShipService } from '../ship.service.js';
import type { ToolContext } from '../tools/tool.js';

export type ShipCall = { ctx: ToolContext; title: string; body: string };

/**
 * A seam fixture's ninth constructor argument. `ThreadSeamService` holds a `ShipService` so the
 * registry can offer `ship_pr`, so every seam fixture needs one whether or not the test ships
 * anything — and a fixture that stopped passing one would make the tool vanish silently.
 *
 * Cast rather than implemented: the real service has private members, and the alternative is
 * exporting a seam nothing but a test would use.
 */
export function fakeShipService(calls: ShipCall[] = []): ShipService {
  return {
    async ship(args: ShipCall): Promise<string> {
      calls.push(args);
      return 'shipped';
    },
  } as unknown as ShipService;
}
