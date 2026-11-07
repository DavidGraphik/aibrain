import { describe, expect, it } from "vitest";
import { mentionQueryAt, mentionTextParts } from "./connector-mention-text";
const apps = [{ id: "composio-gmail", label: "Gmail" }, { id: "composio-googledrive", label: "Google Drive" }];
describe("native inline connector mentions", () => {
  it("finds the query at the caret while retaining following text", () => {
    expect(mentionQueryAt("Antes @gm después", 9)).toEqual({ query: "gm", start: 6, end: 9 });
    expect(mentionQueryAt("correo@ejemplo.com", 10)).toBeNull();
  });
  it("maps selected multiword labels but never grants IDs to unselected plain text", () => {
    expect(mentionTextParts("@Gmail y @Google Drive", apps).filter(p => p.id).map(p => p.id)).toEqual(apps.map(a => a.id));
    expect(mentionTextParts("@Gmail", [])).toEqual([{ text: "@Gmail" }]);
    expect(mentionTextParts("@Gmailx @Google Driv", apps).some(p => p.id)).toBe(false);
  });
  it("preserves Unicode, line breaks, repeated mentions and ordinary clipboard text", () => {
    const text = "你好 @Gmail\n🙂 antes @Google Drive. después @Gmail";
    expect(mentionTextParts(text, apps).map(p => p.text).join("")).toBe(text);
    expect(mentionTextParts(text, apps).filter(p => p.id)).toHaveLength(3);
  });
});
