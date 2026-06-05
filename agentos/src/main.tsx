import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import { Toaster } from "sonner";
import App from "./App.tsx";
import { AuthGate } from "./components/AuthGate.tsx";
import { AuthProvider } from "./context/AuthContext.tsx";
import { AgentsProvider } from "./context/AgentsContext.tsx";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <TooltipProvider delayDuration={300}>
        <AuthProvider>
          <AuthGate>
            <AgentsProvider>
              <App />
            </AgentsProvider>
          </AuthGate>
        </AuthProvider>
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
    </BrowserRouter>
  </React.StrictMode>,
);
