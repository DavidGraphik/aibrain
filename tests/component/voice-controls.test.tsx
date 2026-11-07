// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "../render-spanish";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReadAloudControl, VoiceDictationControl } from "@/components/voice-controls";

type RecognitionHandlers = {
  onstart: (() => void) | null;
  onresult: ((event: Event & { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((event: Event & { error?: string }) => void) | null;
  onend: (() => void) | null;
};

let recognition: RecognitionHandlers & { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; abort: ReturnType<typeof vi.fn> };

class FakeRecognition {
  continuous = false;
  interimResults = false;
  lang = "";
  onstart: RecognitionHandlers["onstart"] = null;
  onresult: RecognitionHandlers["onresult"] = null;
  onerror: RecognitionHandlers["onerror"] = null;
  onend: RecognitionHandlers["onend"] = null;
  start = vi.fn(() => this.onstart?.());
  stop = vi.fn(() => this.onend?.());
  abort = vi.fn(() => this.onend?.());
  constructor() { recognition = this; }
}

class FakeUtterance {
  lang = "";
  rate = 1;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public text: string) {}
}

const speak = vi.fn();
const cancelSpeech = vi.fn();
const stopMicrophoneTrack = vi.fn();
const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: stopMicrophoneTrack }] }));

beforeEach(() => {
  recognition = undefined as unknown as typeof recognition;
  localStorage.clear();
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
  Object.defineProperty(window, "SpeechRecognition", { configurable: true, value: FakeRecognition });
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
  Object.defineProperty(window, "speechSynthesis", {
    configurable: true,
    value: { speak, cancel: cancelSpeech, speaking: false },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, "SpeechRecognition");
  Reflect.deleteProperty(window, "webkitSpeechRecognition");
  Reflect.deleteProperty(window, "speechSynthesis");
  Reflect.deleteProperty(document, "permissionsPolicy");
});

describe("VoiceDictationControl", () => {
  it("asks for explicit consent, inserts editable text, and never sends", async () => {
    const onChange = vi.fn();
    const onNotice = vi.fn();
    vi.useFakeTimers();
    render(<VoiceDictationControl value="Informe:" disabled={false} onChange={onChange} onNotice={onNotice} />);

    fireEvent.click(screen.getByRole("button", { name: "Dictar mensaje" }));
    expect(screen.getByRole("dialog", { name: "Permiso para dictar" })).toBeInTheDocument();
    expect(recognition).toBeUndefined();

    fireEvent.click(screen.getByRole("button", { name: "Activar dictado" }));
    expect(localStorage.getItem("aibrain.voice.dictation-consent.v1")).toBe("accepted");
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole("status")).toHaveTextContent("Escuchando");
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(stopMicrophoneTrack).toHaveBeenCalledOnce();
    act(() => vi.runOnlyPendingTimers());
    expect(screen.getByRole("button", { name: "Terminar dictado" })).toHaveFocus();

    act(() => recognition.onresult?.(Object.assign(new Event("result"), {
      resultIndex: 0,
      results: [{ isFinal: true, 0: { transcript: "ventas semanales" } }],
    })));
    expect(onChange).toHaveBeenLastCalledWith("Informe: ventas semanales");
    expect(screen.getByRole("button", { name: "Terminar dictado" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Terminar dictado" }));
    act(() => vi.advanceTimersByTime(350));
    expect(onNotice).toHaveBeenCalledWith("Dictado añadido. Revísalo y edítalo antes de enviar.", "success");
    act(() => vi.runOnlyPendingTimers());
    expect(screen.getByRole("button", { name: "Dictar mensaje" })).toHaveFocus();
    vi.useRealTimers();
  });

  it("classifies recognition failures as errors", async () => {
    localStorage.setItem("aibrain.voice.dictation-consent.v1", "accepted");
    const onNotice = vi.fn();
    render(<VoiceDictationControl value="" disabled={false} onChange={vi.fn()} onNotice={onNotice} />);
    fireEvent.click(await screen.findByRole("button", { name: "Dictar mensaje" }));
    await waitFor(() => expect(recognition).toBeDefined());
    act(() => recognition.onerror?.(Object.assign(new Event("error"), { error: "network" })));
    expect(onNotice).toHaveBeenCalledWith("El servicio de voz del navegador no está disponible ahora mismo.", "error");
    await waitFor(() => expect(screen.getByRole("button", { name: "Entendido" })).toHaveFocus());
  });

  it("restores the original prompt when dictation is cancelled", async () => {
    localStorage.setItem("aibrain.voice.dictation-consent.v1", "accepted");
    const onChange = vi.fn();
    render(<VoiceDictationControl value="Texto anterior" disabled={false} onChange={onChange} />);
    fireEvent.click(await screen.findByRole("button", { name: "Dictar mensaje" }));
    await waitFor(() => expect(recognition).toBeDefined());
    act(() => recognition.onresult?.(Object.assign(new Event("result"), {
      resultIndex: 0,
      results: [{ isFinal: false, 0: { transcript: "texto temporal" } }],
    })));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar dictado" }));
    expect(recognition.abort).toHaveBeenCalled();
    expect(onChange).toHaveBeenLastCalledWith("Texto anterior");
    await waitFor(() => expect(screen.getByRole("button", { name: "Dictar mensaje" })).toHaveFocus());
  });

  it("shows an honest text fallback when the browser has no recognition API", async () => {
    Reflect.deleteProperty(window, "SpeechRecognition");
    render(<VoiceDictationControl value="" disabled={false} onChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Dictar mensaje" }));
    const fallback = screen.getByRole("dialog", { name: "Dictado no disponible" });
    expect(fallback).toHaveTextContent("no ofrece dictado");
    expect(screen.getByText(/no la simulamos/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Entendido" })).toHaveFocus());
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(fallback).not.toBeInTheDocument());
    const trigger = screen.getByRole("button", { name: "Dictar mensaje" });
    await waitFor(() => expect(trigger).toHaveFocus());
    fireEvent.click(trigger);
    await screen.findByRole("dialog", { name: "Dictado no disponible" });
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog", { name: "Dictado no disponible" })).not.toBeInTheDocument();
  });

  it("surfaces native microphone denial without starting speech recognition", async () => {
    localStorage.setItem("aibrain.voice.dictation-consent.v1", "accepted");
    getUserMedia.mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
    const onNotice = vi.fn();
    render(<VoiceDictationControl value="" disabled={false} onChange={vi.fn()} onNotice={onNotice} />);

    fireEvent.click(screen.getByRole("button", { name: "Dictar mensaje" }));

    await waitFor(() => expect(onNotice).toHaveBeenCalledWith(
      expect.stringMatching(/autorizado el micrófono/i), "error",
    ));
    expect(recognition).toBeUndefined();
  });

  it("shows a policy blocker without asking for device access", async () => {
    localStorage.setItem("aibrain.voice.dictation-consent.v1", "accepted");
    Object.defineProperty(document, "permissionsPolicy", { configurable: true, value: { allowsFeature: () => false } });
    render(<VoiceDictationControl value="Draft" disabled={false} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Dictar mensaje" }));
    expect(await screen.findByRole("dialog", { name: "Revisar el micrófono" })).toHaveTextContent("página está bloqueando");
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(recognition).toBeUndefined();
  });

  it("offers site and system recovery and retries only from a new gesture", async () => {
    localStorage.setItem("aibrain.voice.dictation-consent.v1", "accepted");
    getUserMedia.mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"));
    const onChange = vi.fn();
    render(<VoiceDictationControl value="Draft" disabled={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Dictar mensaje" }));
    expect(await screen.findByRole("dialog", { name: "Revisar el micrófono" })).toHaveTextContent("Configuración del sitio");
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Volver a solicitar permiso" }));
    await waitFor(() => expect(recognition).toBeDefined());
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(stopMicrophoneTrack).toHaveBeenCalledOnce();
  });

  it("requires HTTPS before requesting or starting the microphone", async () => {
    localStorage.setItem("aibrain.voice.dictation-consent.v1", "accepted");
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: false });
    const onNotice = vi.fn();
    render(<VoiceDictationControl value="" disabled={false} onChange={vi.fn()} onNotice={onNotice} />);

    fireEvent.click(screen.getByRole("button", { name: "Dictar mensaje" }));

    expect(onNotice).toHaveBeenCalledWith(expect.stringMatching(/HTTPS/i), "error");
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(recognition).toBeUndefined();
  });
});

describe("ReadAloudControl", () => {
  it("reads only on request, persists the speed, and can stop", async () => {
    render(<ReadAloudControl text="Resultado listo" />);
    expect(speak).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Leer en voz alta" }));
    const rate = screen.getByRole("combobox", { name: "Velocidad de lectura" });
    await waitFor(() => expect(rate).toHaveFocus());
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(screen.getByRole("button", { name: "Reproducir" })).toHaveFocus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(rate).toHaveFocus();
    fireEvent.change(rate, { target: { value: "1.25" } });
    fireEvent.click(screen.getByRole("button", { name: "Reproducir" }));
    expect(localStorage.getItem("aibrain.voice.read-rate.v1")).toBe("1.25");
    expect(speak).toHaveBeenCalledOnce();
    expect(speak.mock.calls[0]?.[0]).toMatchObject({ text: "Resultado listo", lang: "es-ES", rate: 1.25 });
    await waitFor(() => expect(screen.getByRole("button", { name: "Detener lectura" })).toHaveFocus());
    fireEvent.click(screen.getByRole("button", { name: "Detener lectura" }));
    expect(cancelSpeech).toHaveBeenCalled();
  });
});
