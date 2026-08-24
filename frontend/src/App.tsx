import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Navigate, Route, BrowserRouter as Router, Routes } from "react-router-dom";
import { currentUser } from "@/lib/api";
import { Catalog } from "./pages/Catalog";
import { Collection } from "./pages/Collection";
import { CreatorHub } from "./pages/CreatorHub";
import { Creators } from "./pages/Creators";
import { Favorites } from "./pages/Favorites";
import { Home } from "./pages/Home";
import { Learn } from "./pages/Learn";
import { LibraryPage } from "./pages/Library";
import { Login } from "./pages/Login";
import { Me } from "./pages/Me";
import { Search } from "./pages/Search";
import { AdminDashboard } from "./pages/admin/Dashboard";
import { AdminEpisodeEdit } from "./pages/admin/EpisodeEdit";
import { AdminCollectionList } from "./pages/admin/CollectionList";
import { AdminEpisodeList } from "./pages/admin/EpisodeList";
import { AdminImport } from "./pages/admin/Import";
import { AdminReviewQueue } from "./pages/admin/ReviewQueue";
import { Review } from "./pages/Review";
import { AdminSchedules } from "./pages/admin/Schedules";
import { AdminShell } from "./pages/admin/AdminShell";
import { AdminUserList } from "./pages/admin/UserList";
import { useIsHandheld } from "./lib/device";

const qc = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
});

function RequireAuth({ children, admin }: { children: React.ReactNode; admin?: boolean }) {
  const u = currentUser();
  // Not just for the post-login redirect: a bookmark, a restored tab, or a
  // shared link can drop an admin straight onto /admin from a phone. The
  // console assumes a desktop (dense tables, an import flow that drives a
  // local yt-dlp), and reaching it on a handheld leaves the learner app
  // unreachable — so the guard lives on the route, not on the button.
  const handheld = useIsHandheld();
  if (!u) return <Navigate to="/login" replace />;
  if (admin && u.role !== "admin") return <Navigate to="/" replace />;
  if (admin && handheld) return <Navigate to="/" replace />;
  return <>{children}</>;
}

export function App() {
  return (
    <QueryClientProvider client={qc}>
      <Router>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route
            path="/"
            element={
              <RequireAuth>
                <Home />
              </RequireAuth>
            }
          />
          <Route
            path="/catalog"
            element={
              <RequireAuth>
                <Catalog />
              </RequireAuth>
            }
          />
          <Route
            path="/search"
            element={
              <RequireAuth>
                <Search />
              </RequireAuth>
            }
          />
          <Route
            path="/favorites"
            element={
              <RequireAuth>
                <Favorites />
              </RequireAuth>
            }
          />
          <Route
            path="/me"
            element={
              <RequireAuth>
                <Me />
              </RequireAuth>
            }
          />
          <Route
            path="/library"
            element={
              <RequireAuth>
                <LibraryPage />
              </RequireAuth>
            }
          />
          {/* Legacy routes — redirect to the unified Library page. */}
          <Route path="/vocabulary" element={<Navigate to="/library" replace />} />
          <Route path="/words" element={<Navigate to="/library" replace />} />
          <Route
            path="/review"
            element={
              <RequireAuth>
                <Review />
              </RequireAuth>
            }
          />
          <Route
            path="/learn/:id"
            element={
              <RequireAuth>
                <Learn />
              </RequireAuth>
            }
          />
          <Route
            path="/creators"
            element={
              <RequireAuth>
                <Creators />
              </RequireAuth>
            }
          />
          <Route
            path="/creators/:id"
            element={
              <RequireAuth>
                <CreatorHub />
              </RequireAuth>
            }
          />
          <Route
            path="/collection/:id"
            element={
              <RequireAuth>
                <Collection />
              </RequireAuth>
            }
          />
          <Route
            path="/admin"
            element={
              <RequireAuth admin>
                <AdminShell />
              </RequireAuth>
            }
          >
            <Route index element={<AdminDashboard />} />
            <Route path="import" element={<AdminImport />} />
            <Route path="review-queue" element={<AdminReviewQueue />} />
            <Route path="schedules" element={<AdminSchedules />} />
            <Route path="episodes" element={<AdminEpisodeList />} />
            <Route path="episodes/:id" element={<AdminEpisodeEdit />} />
            <Route path="collections" element={<AdminCollectionList />} />
            <Route path="users" element={<AdminUserList />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Router>
    </QueryClientProvider>
  );
}
