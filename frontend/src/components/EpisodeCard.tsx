import { Cards, Play } from "@phosphor-icons/react";
import { Link } from "react-router-dom";
import { TOPIC_META } from "@/lib/topicMeta";
import type { EpisodeCard as EpCard } from "@/lib/api";

function fmtDuration(sec: number) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function DifficultyBar({ n }: { n: number }) {
  return (
    <span className="inline-flex items-center gap-0.5" title={`难度 ${n}/4`}>
      {[0, 1, 2, 3].map((i) => (
        <span
          key={i}
          className={`w-3 h-0.5 rounded-full ${i < n ? "bg-brand" : "bg-line"}`}
        />
      ))}
    </span>
  );
}

export function EpisodeCardView({ ep }: { ep: EpCard }) {
  const topic = TOPIC_META[ep.topic];
  const showTopic = topic && ep.topic !== "other";
  return (
    <Link
      to={`/learn/${ep.id}`}
      className="card overflow-hidden block hover:border-ink-2/40 hover:shadow-md transition-all group"
    >
      <div className="aspect-[16/10] bg-[#f0f3f0] relative overflow-hidden">
        {ep.thumbnail_url ? (
          <img
            src={ep.thumbnail_url}
            alt=""
            className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform duration-300"
          />
        ) : null}
        {showTopic && (
          <span className="absolute left-2 top-2 inline-flex items-center gap-1.5 bg-white/95 text-ink text-2xs px-2 py-1 rounded-md font-medium shadow-sm">
            <span
              className="w-1.5 h-1.5 rounded-full"
              style={{ background: topic.color }}
            />
            {topic.name}
          </span>
        )}
        <span className="absolute right-2 top-2 bg-black/60 text-white text-2xs px-2 py-0.5 rounded-md font-medium">
          {fmtDuration(ep.duration_sec)}
        </span>
        <div className="absolute inset-0 grid place-items-center opacity-0 group-hover:opacity-100 transition-opacity">
          <div className="w-11 h-11 rounded-full bg-white/95 grid place-items-center shadow-lg">
            <Play size={20} className="text-ink translate-x-[1px]" weight="fill" />
          </div>
        </div>
      </div>
      <div className="px-3.5 py-3">
        <h4 className="text-sm font-semibold leading-snug line-clamp-2">{ep.title}</h4>
        {(ep.summary_zh || ep.summary) && (
          <p className="text-2xs text-ink-2 leading-[1.55] mt-1.5 line-clamp-2">
            {ep.summary_zh || ep.summary}
          </p>
        )}
        <div className="flex items-center gap-3 text-2xs text-ink-3 mt-2.5">
          <span className="inline-flex items-center gap-1">
            <Cards size={12} />
            {ep.chunks_count} chunks
          </span>
          <DifficultyBar n={ep.difficulty} />
          <span className="uppercase tracking-wider text-2xs">{ep.accent}</span>
        </div>
      </div>
    </Link>
  );
}
