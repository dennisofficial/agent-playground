import { describe, expect, it } from "bun:test";
import { EAnsiColour } from "../colour.js";
import {
  DEFAULT_SETTINGS,
  parseSettings,
  serialiseSettings,
  type Settings,
} from "../settings.js";

/**
 * The settings file is the first thing in Atlas a human is invited to hand-edit, so "what happens
 * when it is wrong" is a bigger part of the contract than "what happens when it is right". Every
 * test below is a way a real `~/.atlas/settings.json` goes bad: half-written by a crash, edited to
 * an impossible colour, carrying a key from a newer build, or simply not there yet.
 */

describe("parseSettings", () => {
  it("reads a settings file it wrote", () => {
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      codeTheme: "atlas",
      palette: { accent: "#00ff00" },
    };
    expect(parseSettings(serialiseSettings(settings))).toEqual(settings);
  });

  it("falls back to the defaults rather than throwing on unparseable JSON", () => {
    // A crash mid-write leaves a truncated file. The cost of being wrong here is one session in the
    // default theme; the cost of throwing is an app that cannot paint its first frame.
    expect(parseSettings("{ not json")).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings("")).toEqual(DEFAULT_SETTINGS);
  });

  it("falls back on a JSON value that is not an object", () => {
    for (const raw of ["null", "42", '"a string"', "[]"]) {
      expect(parseSettings(raw)).toEqual(DEFAULT_SETTINGS);
    }
  });

  it("keeps the good keys when one key is bad, rather than discarding the file", () => {
    // Whole-file rejection would mean a single typo silently reverting every other preference, and
    // the user would have no way to tell which line did it.
    const parsed = parseSettings(
      JSON.stringify({ codeTheme: "atlas", palette: { accent: "not-a-colour" } }),
    );
    expect(parsed.codeTheme).toBe("atlas");
    expect(parsed.palette).toEqual({});
  });

  it("drops individual palette tokens that are not colours, keeping the rest", () => {
    const parsed = parseSettings(
      JSON.stringify({ palette: { accent: "#00ff00", dim: "chartreuse", warn: "yellow" } }),
    );
    // `#00ff00` is a hex and `yellow` is an ANSI name; `chartreuse` is neither, whatever a browser
    // might think of it.
    expect(parsed.palette).toEqual({ accent: "#00ff00", warn: EAnsiColour.yellow });
  });

  it("rejects a palette token that names something the palette does not have", () => {
    // Guards against a stale file from a build where a token was called something else — writing it
    // through would put a key on the palette object that nothing reads and nothing can remove.
    const parsed = parseSettings(JSON.stringify({ palette: { accnet: "#00ff00" } }));
    expect(parsed.palette).toEqual({});
  });

  it("accepts a nested court group, and rejects a partial one", () => {
    const whole = parseSettings(
      JSON.stringify({
        palette: { court: { agent: "#111111", yours: "#222222", external: "#333333", none: "gray" } },
      }),
    );
    // `EAnsiColour.gray` rather than the bare string: the enum is what makes "this follows the
    // user's terminal" a fact the type system knows, and the price of that is that a literal has to
    // name it. Worth paying — it is the same distinction that keeps an ANSI name out of `mixHex`.
    expect(whole.palette.court).toEqual({
      agent: "#111111",
      yours: "#222222",
      external: "#333333",
      none: EAnsiColour.gray,
    });
    // Half a court is worse than none: it would leave two hues from the stored theme and two from
    // whatever the palette happened to be, which is a colour scheme nobody chose.
    const partial = parseSettings(JSON.stringify({ palette: { court: { agent: "#111111" } } }));
    expect(partial.palette.court).toBeUndefined();
  });

  it("ignores keys it does not know, so an older build can read a newer file", () => {
    const parsed = parseSettings(
      JSON.stringify({ codeTheme: "atlas", somethingFromTheFuture: { nested: true } }),
    );
    expect(parsed.codeTheme).toBe("atlas");
    expect(parsed).not.toHaveProperty("somethingFromTheFuture");
  });

  it("does not trust codeTheme to name a theme that exists", () => {
    // Validating the NAME against the registry is resolveCodeTheme's job and it already falls back
    // safely. What this must not do is let a non-string through to it.
    expect(parseSettings(JSON.stringify({ codeTheme: 7 })).codeTheme).toBe(DEFAULT_SETTINGS.codeTheme);
    expect(parseSettings(JSON.stringify({ codeTheme: "solarized-mauve" })).codeTheme).toBe(
      "solarized-mauve",
    );
  });

  it("round-trips through a file that a human has reformatted", () => {
    const pretty = JSON.stringify({ codeTheme: "atlas", palette: { accent: "#00FF00" } }, null, 2);
    const parsed = parseSettings(pretty);
    expect(parsed.codeTheme).toBe("atlas");
    // Upper-case hex is what a human types and what most pickers emit; normalising on the way in
    // means the editor never shows the same colour two ways.
    expect(parsed.palette.accent).toBe("#00ff00");
  });
});

describe("serialiseSettings", () => {
  it("writes something a human can read and edit", () => {
    const written = serialiseSettings({ ...DEFAULT_SETTINGS, codeTheme: "atlas" });
    // The whole argument for a file over SQLite was that it is diffable and hand-editable. One long
    // line is neither.
    expect(written).toContain("\n");
    expect(written.endsWith("\n")).toBe(true);
  });

  it("survives a round trip through the defaults", () => {
    expect(parseSettings(serialiseSettings(DEFAULT_SETTINGS))).toEqual(DEFAULT_SETTINGS);
  });
});
