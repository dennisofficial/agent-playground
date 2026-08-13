import { testRender } from "@opentui/react/test-utils";
import { describe, expect, it } from "bun:test";
import React, { act } from "react";
import type { JobTitleService } from "../../app/job-title.service.js";
import { ListFooter } from "../components/list-footer.js";
import { useInput } from "../hooks/use-input.js";
import { useJobRename } from "../hooks/use-job-rename.js";
import { ServicesProvider, type Services } from "../services.js";

/**
 * Renaming a job, mounted for real — the field, the keyboard it takes, and what it writes.
 *
 * Hosted in a stand-in rather than in the whole job page because everything worth pinning is in the
 * mode: while it is up, `p` and `n` are letters rather than verbs, and the page underneath must not
 * see them. The host below records every key the mode declines, which is exactly what the page's
 * first-refusal rule hands on.
 */

const WIDTH = 80;
const HEIGHT = 12;
const JOB = { id: "job-1", title: "add avatar upload" };

/** A store-backed fake: `rename` publishes, exactly as the real service does. */
function fakeTitles(renamed: { jobId: string; title: string }[]): {
  service: JobTitleService;
  fail: (message: string) => void;
} {
  const titles = new Map<string, string>();
  const listeners = new Set<() => void>();
  let failure: string | null = null;

  const service = {
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    titleOf: (jobId: string): string | undefined => titles.get(jobId),
    async rename(args: { jobId: string; title: string }): Promise<string> {
      if (failure) throw new Error(failure);
      const title = args.title.trim();
      renamed.push({ jobId: args.jobId, title });
      titles.set(args.jobId, title);
      for (const listener of listeners) listener();
      return title;
    },
  } as unknown as JobTitleService;

  return {
    service,
    fail: (message: string): void => {
      failure = message;
    },
  };
}

function Host(props: { declined: string[] }): React.ReactNode {
  const rename = useJobRename(JOB);

  useInput((input, key) => {
    if (rename.handleKey(input, key)) return;
    // Whatever reaches here is a key the page would have answered itself.
    if (input.length > 0) props.declined.push(input);
    if (input === "r") rename.begin();
  });

  return (
    <box flexDirection="column" width={WIDTH} height={HEIGHT}>
      <text>{`trail: ${rename.title}`}</text>
      <ListFooter
        width={WIDTH}
        height={HEIGHT}
        overlay={rename.overlay}
        hints={rename.active ? undefined : ["p phase · n thread · r rename"]}
        shortcuts={false}
        error={rename.error}
      />
    </box>
  );
}

async function open() {
  const renamed: { jobId: string; title: string }[] = [];
  const declined: string[] = [];
  const titles = fakeTitles(renamed);
  const services = { jobTitleService: titles.service } as unknown as Services;

  const setup = await testRender(
    <ServicesProvider services={services}>
      <Host declined={declined} />
    </ServicesProvider>,
    { width: WIDTH, height: HEIGHT },
  );
  await setup.flush();

  // Inside `act`, and with the wait a lone ESC byte needs — see the new-job page's spec.
  const press = async (run: () => void | Promise<void>): Promise<void> => {
    await act(async () => {
      await run();
      await new Promise((resolve) => setTimeout(resolve, 60));
      await setup.flush();
    });
    await setup.flush();
  };

  return { setup, press, renamed, declined, fail: titles.fail };
}

describe("renaming a job", () => {
  it("opens on the name the job already has — a rename is an edit, not a retype", async () => {
    const { setup, press } = await open();
    try {
      await press(() => setup.mockInput.typeText("r"));
      const frame = setup.captureCharFrame();

      expect(frame).toContain("add avatar upload");
      expect(frame).toContain("⏎ rename · esc cancel");
      // The page's own keys are gone from the footer: the field has taken them.
      expect(frame).not.toContain("p phase");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("owns the keyboard while it is up — the page's verbs are letters in a title", async () => {
    const { setup, press, declined } = await open();
    try {
      await press(() => setup.mockInput.typeText("r"));
      declined.length = 0;

      await press(() => setup.mockInput.typeText("pn"));

      expect(declined).toEqual([]);
      expect(setup.captureCharFrame()).toContain("add avatar uploadpn");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("writes the new name on ⏎ and puts it straight into the trail", async () => {
    const { setup, press, renamed } = await open();
    try {
      await press(() => setup.mockInput.typeText("r"));
      await press(() => setup.mockInput.typeText(" v2"));
      await press(() => setup.mockInput.pressEnter());

      expect(renamed).toEqual([{ jobId: "job-1", title: "add avatar upload v2" }]);
      const frame = setup.captureCharFrame();
      expect(frame).toContain("trail: add avatar upload v2");
      // The field is gone and the page has its keys back.
      expect(frame).toContain("p phase");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("writes nothing on esc, and leaves the name alone", async () => {
    const { setup, press, renamed } = await open();
    try {
      await press(() => setup.mockInput.typeText("r"));
      await press(() => setup.mockInput.typeText(" v2"));
      await press(() => setup.mockInput.pressEscape());

      expect(renamed).toEqual([]);
      const frame = setup.captureCharFrame();
      expect(frame).toContain("trail: add avatar upload");
      expect(frame).not.toContain("⏎ rename");
    } finally {
      setup.renderer.destroy();
    }
  });

  it("says so in the footer when the rename could not be written", async () => {
    const { setup, press, fail } = await open();
    try {
      fail("a job needs a name");
      await press(() => setup.mockInput.typeText("r"));
      await press(() => setup.mockInput.pressEnter());

      expect(setup.captureCharFrame()).toContain("a job needs a name");
    } finally {
      setup.renderer.destroy();
    }
  });
});
