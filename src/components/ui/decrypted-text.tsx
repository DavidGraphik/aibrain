"use client";

// Adapted from the supplied React Bits DecryptedText: view-triggered,
// sequential reveal only. Keep the accessible text stable during scrambling.
import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";

export function DecryptedText({ text, speed = 28 }: { text: string; speed?: number }) {
  const reducedMotion = useReducedMotion();
  const container = useRef<HTMLSpanElement>(null);
  const [displayText, setDisplayText] = useState(text);

  useEffect(() => {
    if (reducedMotion !== false || !container.current) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      let revealed = 0;
      timer = setInterval(() => {
        revealed += 1;
        setDisplayText(text.split("").map((char, index) =>
          char === " " || index < revealed ? char : characters[Math.floor(Math.random() * characters.length)],
        ).join(""));
        if (revealed >= text.length) clearInterval(timer);
      }, speed);
    }, { threshold: 0.1 });
    observer.observe(container.current);
    return () => { observer.disconnect(); clearInterval(timer); };
  }, [text, speed, reducedMotion]);

  return (
    <motion.span ref={container} className="inline-block whitespace-pre-wrap">
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">{reducedMotion !== false ? text : displayText}</span>
    </motion.span>
  );
}
