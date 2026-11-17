import { describe, expect, it } from "vitest";
import { basicParse, cleanDraft, links, platform, recommend, seeds } from "../lib/backlog";

describe("guest backlog", () => {
  it("preserves named recommenders across a batch", () => {
    expect(
      basicParse("Maya recommended Tipper — Cloaked. Sam said to check out Sangoma Records."),
    ).toMatchObject([
      { artist: "Tipper", title: "Cloaked", friend: "Maya" },
      { kind: "label", friend: "Sam" },
    ]);
  });
  it("rejects unapproved platform links", () => {
    for (const value of [
      "javascript:alert(1)",
      "https://bandcamp.com.example.com",
      "https://bandcamp.com@evil.example",
      "http://open.spotify.com/track/id",
    ])
      expect(platform(value)).toBeUndefined();
    expect(links(seeds[1]!).map((link) => link.label)).toContain("Bandcamp");
    expect(
      cleanDraft({ kind: "note", title: "A mystery upload", url: "https://evil.example" })?.url,
    ).toBe("");
  });
  it("uses backlog age unless release age is requested", () => {
    const oldestRelease = { ...seeds[1]!, year: 2005, friend: "Sam" };
    const options = [seeds[0]!, oldestRelease];
    expect(recommend(options, "something older")?.entry.id).toBe("cloaked");
    expect(recommend(options, "older release")?.entry.id).toBe("sangoma");
    expect(recommend(options, "from Sam")?.entry.id).toBe("sangoma");
    expect(recommend(options, "downtempo")?.entry.id).toBe("cloaked");
  });
});
