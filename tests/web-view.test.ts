import { afterEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Keys } from "../web/src/panels.js";
afterEach(() => vi.unstubAllGlobals());
it("renders a usable multiline curl example with no diff markers", () => {
  vi.stubGlobal("location", { origin: "http://127.0.0.1:8317" });
  const html = renderToStaticMarkup(
    createElement(Keys, {
      resource: { data: [], loading: false },
      busy: "",
      model: "model-test",
      onCreate() {},
      onRevoke() {},
      onCopy() {},
      onDismiss() {},
    }),
  );
  expect(html).toContain("http://127.0.0.1:8317/v1/responses");
  expect(html).not.toContain("\n+  -H");
  expect(html).toContain("YOUR_MAPLEPROXY_KEY");
});
