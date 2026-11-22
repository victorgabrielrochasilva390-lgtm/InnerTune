import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Editor } from "./components/Editor";
import { ProjectsScreen } from "./components/ProjectsScreen";
import { TooltipLayer } from "./components/ui";
import { useEditor } from "./store";
import { api } from "./api";
import "./styles.css";

function route(): string | null {
  const m = /^#\/p\/([\w-]+)/.exec(location.hash);
  return m ? m[1] : null;
}

function App() {
  const [pid, setPid] = useState<string | null>(route());
  useEffect(() => {
    const h = () => setPid(route());
    window.addEventListener("hashchange", h);
    api.capabilities().then((caps) => useEditor.getState().set({ caps })).catch(() => {});
    return () => window.removeEventListener("hashchange", h);
  }, []);
  const open = (id: string) => (location.hash = `#/p/${id}`);
  return (
    <>
      {pid ? <Editor key={pid} projectId={pid} onExit={() => (location.hash = "")} onOpen={open} /> : <ProjectsScreen onOpen={open} />}
      <TooltipLayer />
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
