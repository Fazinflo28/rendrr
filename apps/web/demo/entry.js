// Demo build entry: the real app screens with the demo api, mounted into one page.
import React from "react";
import { createRoot } from "react-dom/client";
import { Root } from "../src/rendrr/app.js";

createRoot(document.getElementById("app")).render(React.createElement(Root));

// A small, dismissible note so nobody mistakes the demo for the live app.
const note = document.getElementById("demo-note");
note?.querySelector("button")?.addEventListener("click", () => note.remove());
setTimeout(() => { if (note) { note.style.opacity = "0"; setTimeout(() => note.remove(), 500); } }, 9000);
