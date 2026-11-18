import { describe, expect, it } from "vitest";
import { snippetToHtml } from "../src/utils/snippetHtml";

describe("snippetToHtml", () => {
  it("escapes conversation text before marking matches", () => {
    const html = snippetToHtml(
      'say <img src=x onerror="alert(1)"> and {{HIGHLIGHT}}pineapple{{/HIGHLIGHT}}',
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toMatch(/<mark [^>]*>pineapple<\/mark>$/);
  });

  it("escapes markup inside a highlighted match too", () => {
    const html = snippetToHtml("{{HIGHLIGHT}}<script>x</script>{{/HIGHLIGHT}}");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;</mark>");
  });

  it("keeps plain text and ampersands readable", () => {
    expect(snippetToHtml("Tom & Jerry")).toBe("Tom &amp; Jerry");
    expect(snippetToHtml(undefined)).toBe("");
  });
});
