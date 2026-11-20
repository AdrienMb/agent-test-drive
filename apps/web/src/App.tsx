import { Navigate, Route, Routes } from "react-router";
import { PromptPage } from "./pages/PromptPage";
import { RunPage } from "./pages/RunPage";

export function App({ onLocked }: { onLocked: () => void }) {
  return (
    <Routes>
      <Route path="/" element={<PromptPage onLocked={onLocked} />} />
      <Route path="/runs/:runId" element={<RunPage onLocked={onLocked} />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
