import { describe, expect, it } from "vitest";
import { highlightTerms, stripEventHandlers } from "../src/viewer/messageHtml";

describe("stripEventHandlers (HVN-69)", () => {
  it("removes the event-handler attributes from a tag", () => {
    expect(stripEventHandlers('<img src="x" onerror="alert(1)">')).toBe('<img src="x">');
  });

  it("removes them when the value holds a '>' or a quote of the other kind", () => {
    expect(stripEventHandlers(`<a href="https://a.test/" onclick='go("a>b")'>x</a>`)).toBe(
      '<a href="https://a.test/">x</a>',
    );
  });

  it("removes a boolean, unquoted, upper-case or slash-separated handler", () => {
    expect(stripEventHandlers("<img src=x onerror>")).toBe("<img src=x>");
    expect(stripEventHandlers("<img src=x onload=c>")).toBe("<img src=x>");
    expect(stripEventHandlers("<img SRC=x ONERROR=y>")).toBe("<img SRC=x>");
    expect(stripEventHandlers("<img/onerror=x src=y>")).toBe("<img src=y>");
  });

  it("removes a handler that follows a quoted value with no space between", () => {
    expect(stripEventHandlers('<img src="a.png"onerror=x>')).toBe('<img src="a.png">');
  });

  it("leaves an attribute value that only mentions a handler", () => {
    expect(stripEventHandlers('<img alt="a onerror=b" src=x onload=c>')).toBe(
      '<img alt="a onerror=b" src=x>',
    );
  });

  it("leaves text, escaped markup and comments alone", () => {
    const text = "<p>onerror=alert(1) and &lt;img onerror=x&gt;</p>";
    expect(stripEventHandlers(text)).toBe(text);
    expect(stripEventHandlers("<!-- onerror=x -->")).toBe("<!-- onerror=x -->");
  });

  it("strips each tag of a message and keeps the text between them", () => {
    expect(stripEventHandlers("<b onclick=x>hi</b> onerror=text <i onmouseover=y>")).toBe(
      "<b>hi</b> onerror=text <i>",
    );
  });

  it("returns a message with no handlers unchanged", () => {
    const html = '<p>See <a href="https://a.test/?q=1">the link</a>.</p>';
    expect(stripEventHandlers(html)).toBe(html);
  });
});

describe("highlightTerms (HVN-59)", () => {
  it("leaves a link intact when the query matches its URL text", () => {
    expect(highlightTerms('<a href="https://a.test/x">https://a.test/x</a>', "https")).toBe(
      '<a href="https://a.test/x"><span class="highlight">https</span>://a.test/x</a>',
    );
  });

  it("does not match a tag or attribute name", () => {
    expect(highlightTerms('<a href="/a" class="x">href</a>', "href")).toBe(
      '<a href="/a" class="x"><span class="highlight">href</span></a>',
    );
    expect(highlightTerms('<span class="highlight">x</span>', "span")).toBe(
      '<span class="highlight">x</span>',
    );
  });

  it("does not match inside an entity", () => {
    expect(highlightTerms("Tom &amp; Jerry &lt;3", "amp lt")).toBe("Tom &amp; Jerry &lt;3");
    expect(highlightTerms("Tom &amp; Jerry", "tom amp")).toBe(
      '<span class="highlight">Tom</span> &amp; Jerry',
    );
  });

  it("matches a quoted phrase, ignoring case, and drops the Lunr operators", () => {
    expect(highlightTerms("say Pineapple juice", '"pineapple juice"')).toBe(
      'say <span class="highlight">Pineapple juice</span>',
    );
    expect(highlightTerms("pine apple", "+pine -mango")).toBe(
      '<span class="highlight">pine</span> apple',
    );
  });

  it("returns the HTML unchanged for a blank query", () => {
    expect(highlightTerms("<p>x</p>", "  ")).toBe("<p>x</p>");
  });

  it("leaves a comment alone", () => {
    expect(highlightTerms("<!-- https --> https", "https")).toBe(
      '<!-- https --> <span class="highlight">https</span>',
    );
  });
});
