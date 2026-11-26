import { describe, expect, it } from "vitest";
import { formatTime } from "./chunker.js";
import { extractVideoId } from "./youtube.js";

describe("extractVideoId", () => {
  it("parses common URL forms", () => {
    expect(extractVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(extractVideoId("https://youtu.be/dQw4w9WgXcQ?t=5")).toBe("dQw4w9WgXcQ");
    expect(extractVideoId("https://youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(extractVideoId("nope")).toBeNull();
  });
});

describe("formatTime", () => {
  it("formats hours, minutes and seconds", () => {
    expect(formatTime(3725)).toBe("1:02:05");
    expect(formatTime(75.9)).toBe("1:15");
  });
});
