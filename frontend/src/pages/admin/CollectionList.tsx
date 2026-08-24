import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CaretRight, CheckCircle, CircleNotch, Clock, Eye, EyeSlash, FilmStrip } from "@phosphor-icons/react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import { Pager } from "@/components/Pager";

const PAGE_SIZE = 50;

function fmtDuration(sec: number) {
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} 分`;
  return `${Math.floor(m / 60)} 时 ${m % 60} 分`;
}

export function AdminCollectionList() {
  const qc = useQueryClient();
  const [page, setPage] = useState(0);
  const { data: pageData, isLoading } = useQuery({
    queryKey: ["admin-collections", page],
    queryFn: () => api.adminCollections(PAGE_SIZE, page * PAGE_SIZE),
  });
  const data = pageData?.items;

  const publish = useMutation({
    mutationFn: (yt: string) => api.adminPublishCollection(yt),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-collections"] });
      qc.invalidateQueries({ queryKey: ["collections"] });
    },
  });
  const unpublish = useMutation({
    mutationFn: (yt: string) => api.adminUnpublishCollection(yt),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-collections"] });
      qc.invalidateQueries({ queryKey: ["collections"] });
    },
  });

  return (
    <>
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="text-xl font-bold">合集管理</h2>
          <p className="text-xs text-ink-3 mt-1">
            一键发布或下线整个合集 · 半发布的合集对普通用户不可见
          </p>
        </div>
        <Link to="/admin/import" className="btn-primary">
          + 导入合集
        </Link>
      </div>

      {isLoading && (
        <div className="card p-10 text-center text-ink-3">加载中…</div>
      )}

      {!isLoading && data?.length === 0 && (
        <div className="card p-10 text-center text-ink-3">
          还没有合集。进 YouTube 导入页面，选 "📚 全片切分" 模式导入一个 10+ 分钟的视频试试。
        </div>
      )}

      <div className="flex flex-col gap-3">
        {data?.map((c) => {
          const fullyPublished = c.published_count === c.segment_count;
          const fullyReviewing = c.published_count === 0;
          const isMutating =
            (publish.isPending && publish.variables === c.youtube_id) ||
            (unpublish.isPending && unpublish.variables === c.youtube_id);
          return (
            <div
              key={c.youtube_id}
              className="card p-3 md:p-4 flex flex-col md:flex-row md:items-center gap-3 md:gap-4"
            >
              <div className="shrink-0 w-full md:w-[160px] aspect-video bg-black rounded-lg overflow-hidden">
                {c.thumbnail_url && (
                  <img src={c.thumbnail_url} alt="" className="w-full h-full object-cover" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-base md:text-base font-semibold text-ink line-clamp-2 break-words leading-[1.4]">
                  {c.title}
                </div>
                {c.creator_name && (
                  <div className="text-xs text-ink-3 mt-1">
                    作者 · {c.creator_name}
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-2xs text-ink-2">
                  <span className="inline-flex items-center gap-1">
                    <FilmStrip size={11} />
                    {c.segment_count} 段
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Clock size={11} />
                    {fmtDuration(c.total_duration_sec)}
                  </span>
                  <span
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-semibold ${
                      fullyPublished
                        ? "bg-[#e6f7ef] text-[#16a070]"
                        : fullyReviewing
                          ? "bg-[#fff2d6] text-[#b27700]"
                          : "bg-[#eaf3ec] text-[#285e48]"
                    }`}
                  >
                    {fullyPublished && <CheckCircle size={11} weight="bold" />}
                    {fullyPublished
                      ? `全部已发布 (${c.published_count}/${c.segment_count})`
                      : fullyReviewing
                        ? `全部待审 (0/${c.segment_count})`
                        : `部分发布 (${c.published_count}/${c.segment_count})`}
                  </span>
                  {!fullyPublished && (
                    <span className="text-2xs text-ink-3 italic">
                      用户不可见
                    </span>
                  )}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <Link
                  to={`/collection/${c.youtube_id}`}
                  target="_blank"
                  className="text-xs px-2.5 py-1.5 rounded-md bg-[#eff2ef] hover:bg-[#e3e9e3] inline-flex items-center gap-1"
                  title="在前台查看合集详情页"
                >
                  <Eye size={12} />
                  预览
                </Link>
                <Link
                  to={`/learn/${c.first_episode_id}`}
                  target="_blank"
                  className="text-xs px-2.5 py-1.5 rounded-md bg-[#eff2ef] hover:bg-[#e3e9e3] inline-flex items-center gap-1"
                >
                  段 1
                  <CaretRight size={12} />
                </Link>
                {fullyPublished ? (
                  <button
                    onClick={() => {
                      if (confirm(`下线整个合集（${c.segment_count} 段）？用户将立刻看不到。`)) {
                        unpublish.mutate(c.youtube_id);
                      }
                    }}
                    disabled={isMutating}
                    className="text-xs px-3 py-1.5 rounded-md bg-[#fff2d6] text-[#b27700] hover:bg-[#ffe7b3] font-semibold inline-flex items-center gap-1"
                  >
                    {isMutating ? (
                      <CircleNotch size={12} weight="bold" className="animate-spin" />
                    ) : (
                      <EyeSlash size={12} weight="bold" />
                    )}
                    全集下线
                  </button>
                ) : (
                  <button
                    onClick={() => publish.mutate(c.youtube_id)}
                    disabled={isMutating}
                    className="text-xs px-3 py-1.5 rounded-md bg-[#16a070] text-white hover:bg-[#138a5c] font-semibold inline-flex items-center gap-1"
                  >
                    {isMutating ? (
                      <CircleNotch size={12} weight="bold" className="animate-spin" />
                    ) : (
                      <CheckCircle size={12} weight="bold" />
                    )}
                    全集发布
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <Pager page={page} pageSize={PAGE_SIZE} total={pageData?.total ?? 0} onPage={setPage} />

      <div className="text-xs text-ink-3 mt-4">
        共 <b className="text-ink">{pageData?.total ?? 0}</b> 个合集
      </div>
    </>
  );
}
