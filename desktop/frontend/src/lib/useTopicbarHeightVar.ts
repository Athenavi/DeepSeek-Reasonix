// Publishes the topic bar's measured height as --topicbar-live-height on the
// document root. The dock column aligns its own top edge with the bar, and the
// bar's height is not a constant: it differs per layout style (classic /
// workbench / creation), per theme skin and per platform caption strip.
import { useEffect } from "react";

const VAR = "--topicbar-live-height";

export function useTopicbarHeightVar(): void {
  useEffect(() => {
    const publish = () => {
      const bar = document.querySelector<HTMLElement>(".topicbar");
      if (!bar) return;
      const height = Math.round(bar.getBoundingClientRect().height);
      if (height > 0) document.documentElement.style.setProperty(VAR, `${height}px`);
    };
    publish();
    const bar = document.querySelector<HTMLElement>(".topicbar");
    if (!bar || typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", publish);
      return () => window.removeEventListener("resize", publish);
    }
    const observer = new ResizeObserver(publish);
    observer.observe(bar);
    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty(VAR);
    };
  }, []);
}
