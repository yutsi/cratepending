import { describe, expect, it, vi } from "vitest";
import worker from "../worker";

type WorkerArgs = Parameters<typeof worker.fetch>;

function setup() {
  const infer = vi.fn();
  const lookup = vi.fn();
  const admit = vi.fn(async () => ({ success: true }));
  const env = {
    AI_MODEL: "test-model",
    AI: { run: infer },
    CATALOG: { idFromName: () => "catalog", get: () => ({ fetch: lookup }) },
    PARSE_LIMIT: { limit: admit },
  } as unknown as WorkerArgs[1];
  const parse = (text: string, headers: Record<string, string> = {}) =>
    worker.fetch(
      new Request("https://demo.example/api/batch/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ text }),
      }) as unknown as WorkerArgs[0],
      env,
    );
  return { infer, lookup, admit, parse };
}

describe("public batch endpoint", () => {
  it("runs the catalog tool before returning editable, unpersisted suggestions", async () => {
    const { infer, lookup, parse } = setup();
    infer.mockResolvedValueOnce({
      choices: [
        {
          message: {
            tool_calls: [
              {
                function: {
                  name: "searchMusicBrainz",
                  arguments: JSON.stringify({ kind: "label", title: "Sangoma Records" }),
                },
              },
            ],
          },
        },
      ],
    });
    infer.mockResolvedValueOnce({
      response: JSON.stringify({
        entries: [
          {
            kind: "label",
            title: "Sangoma Records",
            friend: "Maya",
            url: "https://other.example/",
          },
        ],
      }),
    });
    lookup.mockResolvedValueOnce(
      Response.json({
        candidates: [
          {
            kind: "label",
            id: "catalog-id",
            title: "Sangoma Records",
            artist: "",
            url: "https://sangomarecs.bandcamp.com/",
          },
        ],
      }),
    );
    const response = await parse("Maya recommended Sangoma Records.");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      entries: [{ kind: "label", title: "Sangoma Records", friend: "Maya", url: "" }],
      candidates: [{ id: "catalog-id", url: "https://sangomarecs.bandcamp.com/" }],
    });
    expect(lookup).toHaveBeenCalledOnce();
    expect(infer).toHaveBeenCalledTimes(2);
    expect(lookup.mock.calls[0]?.[1]?.body).not.toContain("Maya");
  });

  it("rejects cross-origin requests and exhausted quotas without a model call", async () => {
    const { infer, admit, parse } = setup();
    expect((await parse("Hi", { Origin: "https://other.example" })).status).toBe(403);
    admit.mockResolvedValueOnce({ success: false });
    expect((await parse("Hi")).status).toBe(429);
    expect(infer).not.toHaveBeenCalled();
  });
});
