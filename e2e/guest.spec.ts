import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/account", (route) =>
    route.fulfill({ json: { enabled: false, signedIn: false } }),
  );
  await page.goto("/");
});

test("saves raw text after quota failure and keeps it after refresh", async ({ page }) => {
  await page.route("**/api/batch/parse", (route) => route.fulfill({ status: 503 }));
  const text = "  Rae recommended this unknown upload.\n  No catalog result.  ";
  await page.getByLabel("What should you check out?").fill(text);
  await page.getByRole("button", { name: "Parse with AI" }).click();
  await expect(page.getByRole("status")).toContainText("Live AI is unavailable");
  await page.getByRole("button", { name: "Save original text" }).click();
  await page.reload();
  const original = await page.evaluate(
    () => JSON.parse(sessionStorage.getItem("cratepending:guest:v1") ?? "[]")[0]?.original,
  );
  expect(original).toBe(text);
  await expect(page.getByRole("heading", { name: "Sangoma Records", exact: true })).toBeVisible();
});

test("edits a friend attribution before saving", async ({ page }) => {
  await page.route("**/api/batch/parse", (route) =>
    route.fulfill({
      json: {
        entries: [
          {
            kind: "track",
            title: "Obscure upload",
            artist: "DJ Example",
            friend: "Mya",
            tags: [],
            url: "",
          },
        ],
        candidates: [],
      },
    }),
  );
  await page.getByLabel("What should you check out?").fill("Maya recommended an obscure upload.");
  await page.getByRole("button", { name: "Parse with AI" }).click();
  await page.getByLabel("Recommended by").fill("Maya");
  await page.getByRole("button", { name: "Save 1 entry" }).click();
  await expect(page.getByText("DJ Example · From Maya")).toBeVisible();
});

test("supports keyboard navigation, system theme, and manual override", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await expect
    .poll(() => page.locator("html").evaluate((node) => getComputedStyle(node).colorScheme))
    .toBe("dark");
  await page.getByLabel("Theme").selectOption("Light");
  await page.reload();
  await expect(page.getByLabel("Theme")).toHaveValue("Light");
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze())
      .violations,
  ).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await page.evaluate(() => innerWidth),
  );
});
