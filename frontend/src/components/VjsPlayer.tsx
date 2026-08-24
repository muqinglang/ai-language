import { useEffect, useRef } from "react";
import videojs from "video.js";
import "video.js/dist/video-js.css";

type Player = ReturnType<typeof videojs>;

export type VjsPlayerHandle = {
  seek: (seconds: number) => void;
  play: () => void;
  pause: () => void;
  getCurrentTime: () => number;
  getPlayer: () => Player | null;
};

/**
 * Thin wrapper around video.js. Owns the <video> element + all standard player
 * controls. Streams time / active cue changes up via callbacks so the parent
 * can drive subtitle highlighting without owning a second timeupdate loop.
 *
 * Subtitles are loaded via a WebVTT URL (`vttUrl`); the browser's native
 * TextTrack API produces the cuechange events — no manual timing math.
 */
export function VjsPlayer({
  src,
  poster,
  vttUrl,
  segmentStart,
  segmentEnd,
  onTimeMs,
  onActiveCueIndex,
  onReady,
  onPlay,
  onEnded,
  onError,
  mediaTitle,
  mediaArtist,
  mediaArtwork,
  onNextTrack,
  onPrevTrack,
}: {
  src: string;
  poster?: string;
  vttUrl?: string;
  segmentStart?: number; // seconds
  segmentEnd?: number;   // seconds
  onTimeMs?: (ms: number) => void;
  onActiveCueIndex?: (index: number | null) => void;
  onReady?: (handle: VjsPlayerHandle) => void;
  /** Fires whenever playback transitions from paused → playing. Used by
   * the parent to silence any AI-bubble TTS when the learner restarts
   * the video, so the two audio sources don't compete. */
  onPlay?: () => void;
  /** Fires when the video reaches its natural end. Parent uses this to
   * implement full-video loop (seek 0 + play again). */
  onEnded?: () => void;
  /** Fires on a media error (e.g. a slightly-corrupt file tail that throws
   * a decode error instead of firing `ended`). Parent uses this to keep a
   * collection loop alive when a clip can't end cleanly. */
  onError?: (info: { code: number; currentTime: number; duration: number }) => void;
  /** MediaSession metadata for OS lock-screen / Bluetooth controls.
   * When present the OS shows a now-playing card with title + artwork
   * and forwards play/pause/seek back into the player, which also
   * keeps audio alive when the user locks the phone. */
  mediaTitle?: string;
  mediaArtist?: string;
  mediaArtwork?: string;
  /** 锁屏卡片 / 蓝牙耳机的上一首下一首。没传就不注册那两个按钮。 */
  onNextTrack?: () => void;
  onPrevTrack?: () => void;
}) {
  const videoHostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<Player | null>(null);
  // Keep segment props in a ref so the long-lived timeupdate handler always
  // reads the latest values, even if props change after mount.
  const segRef = useRef({ start: segmentStart, end: segmentEnd });
  segRef.current = { start: segmentStart, end: segmentEnd };
  // Same pattern for the play/ended handlers — parent may rebind them on
  // re-render, but the video.js player is created once per src.  Latest
  // ref keeps the handler pointing at fresh state (e.g., the latest
  // loopVideo flag) without re-creating the player.
  const onPlayRef = useRef(onPlay);
  const onEndedRef = useRef(onEnded);
  const onErrorRef = useRef(onError);
  const onNextRef = useRef(onNextTrack);
  const onPrevRef = useRef(onPrevTrack);
  onPlayRef.current = onPlay;
  onEndedRef.current = onEnded;
  onErrorRef.current = onError;
  onNextRef.current = onNextTrack;
  onPrevRef.current = onPrevTrack;
  // 换源时是否要接着播。只有"上一段自然播完"才置 true —— 用户主动
  // 停在某一集时不该被自动开走。
  const wasPlayingRef = useRef(false);
  // 「已经把播放头挪进片段起点」的标记。以前是 effect 里的局部变量，
  // 换源不重建之后它必须活得比一次 src 长，所以提成 ref，换源时重置。
  const snappedRef = useRef(false);
  // 换源后要重新绑字幕 cuechange，处理函数由创建 effect 存进来。
  const attachCueRef = useRef<(() => void) | null>(null);

  // --- init once per src ---
  useEffect(() => {
    if (!videoHostRef.current) return;

    // video.js mutates the provided <video> so we build it fresh each time.
    const videoEl = document.createElement("video");
    videoEl.className = "video-js vjs-big-play-centered w-full h-full";
    videoEl.setAttribute("playsinline", "");
    videoEl.setAttribute("crossorigin", "anonymous");
    videoHostRef.current.replaceChildren(videoEl);

    const player = videojs(videoEl, {
      controls: true,
      preload: "auto",
      fluid: false,
      responsive: true,
      poster,
      sources: [{ src, type: guessMime(src) }],
      playbackRates: [0.5, 0.75, 1, 1.25, 1.5, 2],
    });
    playerRef.current = player;

    // Attach subtitles track
    if (vttUrl) {
      player.addRemoteTextTrack(
        { kind: "subtitles", srclang: "en", label: "English", src: vttUrl, default: true },
        false,
      );
    }

    // Initial snap into segment: done ONCE, inside timeupdate, so we don't
    // fight a race with the loadedmetadata event on cached media.
    const onTime = () => {
      const t = player.currentTime() ?? 0;
      onTimeMs?.(t * 1000);

      const segStart = segRef.current.start;
      const segEnd = segRef.current.end;

      if (segStart != null && !snappedRef.current && t < segStart - 0.05) {
        player.currentTime(segStart);
        snappedRef.current = true;
        return;
      }
      if (segStart != null && t >= segStart - 0.05) {
        snappedRef.current = true;
      }

      if (segEnd != null && t >= segEnd - 0.05) {
        player.pause();
        player.currentTime(segEnd - 0.15);
      }
    };
    player.on("timeupdate", onTime);
    player.one("loadedmetadata", onTime);
    if ((player.readyState() ?? 0) >= 1) onTime();

    // Mobile: tap the video surface to toggle play/pause. video.js's
    // default touch behaviour only reveals the control bar on the first
    // tap, so users had to tap twice to pause. We listen for touchend
    // on the underlying <video> element itself — before the video has
    // started, the big play button overlays it and absorbs the touch
    // (so the first start is still its job); once playing, that button
    // is gone and taps land here.
    const videoTapEl = player.el().querySelector("video");
    const onVideoTap = () => {
      if (player.paused()) {
        const p = player.play();
        if (p && typeof (p as Promise<void>).catch === "function") {
          (p as Promise<void>).catch(() => {});
        }
      } else {
        player.pause();
      }
    };
    videoTapEl?.addEventListener("touchend", onVideoTap);

    // Forward the standard HTML media events to the parent.  Bound via
    // refs so the handlers can read fresh closure state (loopVideo
    // toggle, currentMs cursor) without re-creating the player.
    player.on("play", () => { wasPlayingRef.current = true; onPlayRef.current?.(); });
    // 自然播完 = 接下来那次换源应该继续播（连播的核心判据）。
    // 用户手动暂停则会把它清掉，所以停在某一集不会被自动带走。
    player.on("ended", () => { wasPlayingRef.current = true; onEndedRef.current?.(); });
    player.on("pause", () => {
      // 播放到末尾时浏览器也会发 pause，那种不算用户暂停。
      const d = player.duration() ?? 0;
      const t = player.currentTime() ?? 0;
      if (!(d > 0 && t >= d - 0.5)) wasPlayingRef.current = false;
    });
    player.on("error", () => {
      const err = player.error();
      onErrorRef.current?.({
        code: err?.code ?? 0,
        currentTime: player.currentTime() ?? 0,
        duration: player.duration() ?? 0,
      });
    });

    // --- MediaSession: lock-screen / Bluetooth controls + background audio.
    //
    // Registering metadata + action handlers tells iOS/Android "this page
    // is playing media", so the OS:
    //   1. shows a now-playing card on the lock screen (title + artwork)
    //   2. keeps audio alive when the user locks the phone or switches tabs
    //      (without this, mobile browsers pause the <video> on visibilitychange)
    //   3. routes bluetooth headphone play/pause/seek buttons back to us
    //
    // Safe on browsers without MediaSession (older Safari) — feature detect.
    const ms: MediaSession | undefined =
      typeof navigator !== "undefined" ? navigator.mediaSession : undefined;
    if (ms) {
      try {
        const artwork = mediaArtwork
          ? [
              { src: mediaArtwork, sizes: "512x512", type: "image/jpeg" },
              { src: mediaArtwork, sizes: "256x256", type: "image/jpeg" },
            ]
          : [];
        ms.metadata = new MediaMetadata({
          title: mediaTitle || "justSpeak",
          artist: mediaArtist || "justSpeak",
          album: "justSpeak",
          artwork,
        });
      } catch { /* metadata setup is best-effort */ }

      const safe = (fn: () => void) => {
        try { fn(); } catch { /* ignore */ }
      };

      safe(() => ms.setActionHandler("play", () => {
        const p = player.play();
        if (p && typeof (p as Promise<void>).catch === "function") {
          (p as Promise<void>).catch(() => {});
        }
      }));
      safe(() => ms.setActionHandler("pause", () => player.pause()));
      safe(() => ms.setActionHandler("seekbackward", (details) => {
        const offset = details.seekOffset ?? 10;
        const t = player.currentTime() ?? 0;
        player.currentTime(Math.max(0, t - offset));
      }));
      safe(() => ms.setActionHandler("seekforward", (details) => {
        const offset = details.seekOffset ?? 10;
        const t = player.currentTime() ?? 0;
        const d = player.duration() ?? Number.POSITIVE_INFINITY;
        player.currentTime(Math.min(d, t + offset));
      }));
      safe(() => ms.setActionHandler("seekto", (details) => {
        if (details.seekTime != null) player.currentTime(details.seekTime);
      }));
      // 锁屏卡片 / 耳机线控的上一首下一首。口袋里切集全靠这两个。
      safe(() => ms.setActionHandler("nexttrack", () => {
        wasPlayingRef.current = true;
        onNextRef.current?.();
      }));
      safe(() => ms.setActionHandler("previoustrack", () => {
        wasPlayingRef.current = true;
        onPrevRef.current?.();
      }));

      // Mirror the actual playback state so the lock-screen card shows
      // the right play/pause icon. Safari ignores this in some versions
      // but it's harmless and Android Chrome relies on it.
      player.on("play", () => { ms.playbackState = "playing"; });
      player.on("pause", () => { ms.playbackState = "paused"; });
      player.on("ended", () => { ms.playbackState = "none"; });

      // Keep position state fresh-ish (once per second) so the lock-screen
      // scrubber tracks the real timeline. setPositionState throws if
      // duration is NaN, so guard it.
      let lastPos = 0;
      player.on("timeupdate", () => {
        if (typeof ms.setPositionState !== "function") return;
        const now = performance.now();
        if (now - lastPos < 1000) return;
        lastPos = now;
        const d = player.duration();
        const t = player.currentTime() ?? 0;
        const rate = player.playbackRate() ?? 1;
        if (!d || !isFinite(d)) return;
        try {
          ms.setPositionState({ duration: d, position: Math.min(t, d), playbackRate: rate });
        } catch { /* ignore */ }
      });
    }

    // Wire cuechange once the track exists. addRemoteTextTrack returns after
    // the element is attached but the TextTrack readyState may still be 0.
    const attachCueChange = () => {
      // TextTrackList lacks a spread-friendly typing; iterate with getTrackById
      // or the videojs list helper. The simplest safe approach: iterate length.
      const trackList = player.textTracks();
      const tracks: TextTrack[] = [];
      for (let i = 0; i < trackList.length; i++) {
        // video.js TextTrackList#item(i) mirrors the spec but isn't typed
        const t = (trackList as unknown as { item: (i: number) => TextTrack }).item?.(i)
          ?? (trackList as unknown as Record<number, TextTrack>)[i];
        if (t) tracks.push(t);
      }
      for (const track of tracks) {
        if (track.kind !== "subtitles") continue;
        track.mode = "showing";
        const onCueChange = () => {
          const active = track.activeCues?.[0] ?? null;
          if (!active) {
            onActiveCueIndex?.(null);
            return;
          }
          let idx: number | null = null;
          const cues = track.cues;
          if (cues) {
            for (let j = 0; j < cues.length; j++) {
              if (cues[j] === active) {
                idx = j;
                break;
              }
            }
          }
          onActiveCueIndex?.(idx);
        };
        track.addEventListener("cuechange", onCueChange);
      }
    };
    attachCueRef.current = attachCueChange;
    player.ready(attachCueChange);
    // Also retry after metadata load (track may be added later)
    player.on("loadeddata", attachCueChange);

    // Expose imperative handle — defer until the player is actually ready,
    // otherwise currentTime() calls may no-op on the underlying element.
    player.ready(() => {
      onReady?.({
        seek: (sec) => {
          player.currentTime(sec);
          // User-initiated seek may have gone past segment start → unlock clamp
          snappedRef.current = true;
        },
        play: () => {
          const p = player.play();
          if (p && typeof (p as Promise<void>).catch === "function") {
            (p as Promise<void>).catch(() => {});
          }
        },
        pause: () => player.pause(),
        getCurrentTime: () => player.currentTime() ?? 0,
        getPlayer: () => player,
      });
    });

    return () => {
      // Clear MediaSession so a stale episode card doesn't linger on the
      // lock screen after the user navigates away.
      if (ms) {
        try { ms.metadata = null; } catch { /* ignore */ }
        try { ms.playbackState = "none"; } catch { /* ignore */ }
        for (const action of [
          "play", "pause", "seekbackward", "seekforward", "seekto",
          "nexttrack", "previoustrack",
        ] as const) {
          try { ms.setActionHandler(action, null); } catch { /* ignore */ }
        }
      }
      videoTapEl?.removeEventListener("touchend", onVideoTap);
      player.dispose();
      playerRef.current = null;
    };
    // 只在挂载时创建一次。src / 字幕 / 元数据的变化交给下面几个 effect
    // 就地更新 —— dispose 重建会新建一个 <video> 元素，而浏览器只允许
    // "用户激活过的那个元素"在后台继续播；重建等于锁屏后必然断。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- 换源：同一个 player、同一个 <video>，只换 src ---
  useEffect(() => {
    const player = playerRef.current;
    if (!player || !src) return;
    const cur = player.currentSrc() ?? "";
    if (cur && srcMatches(cur, src)) return;

    const shouldPlay = wasPlayingRef.current || !player.paused();
    snappedRef.current = false;
    player.src({ src, type: guessMime(src) });
    if (poster) player.poster(poster);
    if (shouldPlay) {
      // 关键的一步：元素没换过，用户此前激活过它，所以这次 play() 在
      // 锁屏/后台也会被允许。真正的连播就靠这个。
      const p = player.play();
      if (p && typeof (p as Promise<void>).catch === "function") {
        (p as Promise<void>).catch(() => {});
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  // --- 换字幕轨 ---
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const list = player.remoteTextTracks();
    for (let i = list.length - 1; i >= 0; i--) {
      const t = (list as unknown as { item?: (i: number) => TextTrack })
        .item?.(i) ?? (list as unknown as Record<number, TextTrack>)[i];
      if (t) {
        try { player.removeRemoteTextTrack(t as unknown as HTMLTrackElement); }
        catch { /* ignore */ }
      }
    }
    if (vttUrl) {
      player.addRemoteTextTrack(
        { kind: "subtitles", srclang: "en", label: "English", src: vttUrl, default: true },
        false,
      );
      attachCueRef.current?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vttUrl]);

  // --- 换锁屏卡片上的标题/封面 ---
  useEffect(() => {
    const ms = typeof navigator !== "undefined" ? navigator.mediaSession : undefined;
    if (!ms || !playerRef.current) return;
    try {
      ms.metadata = new MediaMetadata({
        title: mediaTitle || "justSpeak",
        artist: mediaArtist || "justSpeak",
        album: "justSpeak",
        artwork: mediaArtwork
          ? [
              { src: mediaArtwork, sizes: "512x512", type: "image/jpeg" },
              { src: mediaArtwork, sizes: "256x256", type: "image/jpeg" },
            ]
          : [],
      });
    } catch { /* best-effort */ }
  }, [mediaTitle, mediaArtist, mediaArtwork]);

  return <div ref={videoHostRef} className="w-full aspect-video bg-black rounded-xl overflow-hidden" />;
}

/** currentSrc 是绝对 URL，props 里的 src 可能是相对路径 —— 比对尾部即可。 */
function srcMatches(currentSrc: string, next: string): boolean {
  if (currentSrc === next) return true;
  try {
    return new URL(currentSrc, window.location.href).pathname
      === new URL(next, window.location.href).pathname;
  } catch {
    return false;
  }
}

function guessMime(src: string): string {
  const ext = src.split(".").pop()?.toLowerCase().split(/[?#]/)[0] ?? "";
  return (
    {
      mp4: "video/mp4",
      webm: "video/webm",
      ogg: "video/ogg",
      m4a: "audio/mp4",
      mp3: "audio/mpeg",
      wav: "audio/wav",
    }[ext] ?? "video/mp4"
  );
}
