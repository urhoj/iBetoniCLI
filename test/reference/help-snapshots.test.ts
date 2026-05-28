import { describe, test, expect } from "vitest";
import { COMMAND_SPECS } from "../../src/reference/specs.js";
import { formatHelp } from "../../src/output/help.js";

describe("Help snapshots — contract stability", () => {
  for (const spec of COMMAND_SPECS) {
    test(`help for ${spec.command} matches snapshot`, () => {
      expect(formatHelp(spec)).toMatchSnapshot();
    });
  }
});
