import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import HolderPortal from "../prototypes/holder-portal.jsx";
import IssuerConsole from "../prototypes/issuer-console.jsx";
import "./index.css";

const APPS = [
  ["holder", "Holder portal", HolderPortal],
  ["issuer", "Issuer console", IssuerConsole],
];

const fromHash = () => (APPS.some(([k]) => "#" + k === window.location.hash) ? window.location.hash.slice(1) : "holder");

function Demo() {
  const [app, setApp] = useState(fromHash);
  useEffect(() => {
    const onHash = () => setApp(fromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const Active = APPS.find(([k]) => k === app)[2];

  return (
    <div>
      <div style={{ background: "#1A2233", color: "#FBFAF7", fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
        fontSize: 13, padding: "10px 16px" }}>
        <div className="mx-auto flex flex-wrap items-center gap-x-4 gap-y-1" style={{ maxWidth: 560 }}>
          <span style={{ opacity: 0.7 }}>Demo</span>
          {APPS.map(([k, label]) => (
            <a key={k} href={"#" + k}
              style={{ color: "#FBFAF7", fontWeight: app === k ? 600 : 400,
                textDecoration: app === k ? "underline" : "none", textUnderlineOffset: 3 }}>
              {label}
            </a>
          ))}
          <span style={{ opacity: 0.7, flexBasis: "100%" }}>
            Each app has its own sample data, kept in memory. Nothing carries between them or survives a reload.
          </span>
        </div>
      </div>
      <Active key={app} />
    </div>
  );
}

createRoot(document.getElementById("root")).render(<Demo />);
