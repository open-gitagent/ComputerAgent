import React from "react";
import ReactDOM from "react-dom/client";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import { Toaster } from "sonner";
import App from "./App.tsx";
import { AuthGate } from "./components/AuthGate.tsx";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <TooltipProvider delayDuration={300}>
      <AuthGate>
        <App />
      </AuthGate>
      <Toaster
        theme="dark"
        richColors
        closeButton
        position="bottom-right"
        toastOptions={{
          classNames: {
            toast: "bg-card border-border text-card-foreground",
          },
        }}
      />
    </TooltipProvider>
  </React.StrictMode>,
);
