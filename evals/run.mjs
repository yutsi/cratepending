import { readFile } from "node:fs/promises";

const target = process.argv[2];
if (!target) throw new Error("Pass the base URL of a configured instance.");
const cases = JSON.parse(await readFile(new URL("./cases.json", import.meta.url), "utf8"));
for (const sample of cases) {
  const response = await fetch(new URL("/api/batch/parse", target), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: sample.text }),
  });
  const batch = await response.json();
  const passed =
    response.ok &&
    sample.expected.every((draft) =>
      batch.entries.some((entry) =>
        Object.entries(draft).every(([key, value]) =>
          entry[key]?.toLowerCase().includes(value.toLowerCase()),
        ),
      ),
    );
  console.log(passed ? "PASS" : "REVIEW", sample.case, response.status);
  if (!passed) process.exitCode = 1;
}
