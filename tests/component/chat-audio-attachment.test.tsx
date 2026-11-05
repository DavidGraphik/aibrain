// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "../render-spanish";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatAudioAttachment } from "@/components/chat-audio-attachment";

const thread = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";
const version = "33333333-3333-4333-8333-333333333333";
const later = "44444444-4444-4444-8444-444444444444";
const attachment = { id, name: "voice.ogg", mimeType: "audio/ogg", size: 125139 };
const prefix = `/api/threads/${thread}/documents/${id}`;
const original = { versionId: version, kind: "audio", mediaType: "audio/ogg", fileName: attachment.name,
  size: attachment.size, sha256: "a".repeat(64), downloadUrl: `${prefix}/versions/${version}`,
  previewUrl: `${prefix}/versions/${version}/preview/preview.txt` };
const history = () => ({ document: { threadId: thread, documentId: id, originalVersionId: version,
  latestVersionId: later, versions: [original, { ...original, versionId: later, fileName: "edited.ogg" }] } });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("original audio controls in saved messages", () => {
  it("loads only on demand and exposes the immutable original and its attested transcript", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(history())); vi.stubGlobal("fetch", fetcher);
    render(<ChatAudioAttachment attachment={attachment} threadId={thread} />);
    expect(fetcher).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Ver audio voice.ogg" }));
    expect(await screen.findByRole("link", { name: "Descargar original de voice.ogg" })).toHaveAttribute("href", original.downloadUrl);
    expect(screen.getByRole("link", { name: "Ver transcripción de voice.ogg" })).toHaveAttribute("href", original.previewUrl);
    expect(fetcher).toHaveBeenCalledWith(prefix, expect.objectContaining({ credentials: "same-origin", cache: "no-store" }));
    expect(screen.getByRole("link", { name: "Descargar original de voice.ogg" })).toHaveAttribute("download", attachment.name);
  });
  it.each(["foreign-thread", "foreign-document", "remote-url", "changed-size", "invalid-sha"])("rejects %s metadata without exposing a download", async (kind) => {
    const data = history();
    if (kind === "foreign-thread") data.document.threadId = later;
    if (kind === "foreign-document") data.document.documentId = later;
    if (kind === "remote-url") data.document.versions[0] = { ...original, downloadUrl: "https://foreign.example/audio" };
    if (kind === "changed-size") data.document.versions[0] = { ...original, size: 1 };
    if (kind === "invalid-sha") data.document.versions[0] = { ...original, sha256: "unknown" };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(data)));
    render(<ChatAudioAttachment attachment={attachment} threadId={thread} />);
    fireEvent.click(screen.getByRole("button", { name: "Ver audio voice.ogg" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("No se ha podido abrir este audio.");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
  it("retains authorization errors as unavailable and permits a bounded user retry", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ error: "private details" }, { status: 403 })).mockResolvedValueOnce(Response.json(history()));
    vi.stubGlobal("fetch", fetcher);
    render(<ChatAudioAttachment attachment={attachment} threadId={thread} />);
    fireEvent.click(screen.getByRole("button", { name: "Ver audio voice.ogg" }));
    await screen.findByRole("alert"); expect(screen.queryByText("private details")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Ver audio voice.ogg" }));
    await screen.findByRole("link", { name: "Descargar original de voice.ogg" });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  });
  it("does not display resolved links after changing thread identity", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(history())));
    const view = render(<ChatAudioAttachment attachment={attachment} threadId={thread} />);
    fireEvent.click(screen.getByRole("button", { name: "Ver audio voice.ogg" }));
    await screen.findByRole("link", { name: "Descargar original de voice.ogg" });
    view.rerender(<ChatAudioAttachment attachment={attachment} threadId={later} />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
