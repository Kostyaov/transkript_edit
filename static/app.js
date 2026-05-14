const state = {
  project: null,
  segments: [],
  selectedId: null,
  activeId: null,
  speakerColors: new Map(),
  dirty: false,
};

const speakerPalette = [
  { bg: "#fff3bf", active: "#ffe066", border: "#f08c00" },
  { bg: "#d3f9d8", active: "#8ce99a", border: "#2f9e44" },
  { bg: "#d0ebff", active: "#74c0fc", border: "#1c7ed6" },
  { bg: "#ffe3e3", active: "#ffa8a8", border: "#e03131" },
  { bg: "#e5dbff", active: "#b197fc", border: "#7048e8" },
  { bg: "#c5f6fa", active: "#66d9e8", border: "#0c8599" },
  { bg: "#ffec99", active: "#ffd43b", border: "#e67700" },
  { bg: "#f8d7da", active: "#f1aeb5", border: "#c92a2a" },
];

const nodes = {
  audioInput: document.querySelector("#audioInput"),
  transcriptInput: document.querySelector("#transcriptInput"),
  createButton: document.querySelector("#createButton"),
  recentPanel: document.querySelector("#recentPanel"),
  recentProjects: document.querySelector("#recentProjects"),
  openRecentButton: document.querySelector("#openRecentButton"),
  importStatus: document.querySelector("#importStatus"),
  importPanel: document.querySelector("#importPanel"),
  editorPanel: document.querySelector("#editorPanel"),
  audioPlayer: document.querySelector("#audioPlayer"),
  searchInput: document.querySelector("#searchInput"),
  rateInput: document.querySelector("#rateInput"),
  rateOutput: document.querySelector("#rateOutput"),
  currentTime: document.querySelector("#currentTime"),
  projectName: document.querySelector("#projectName"),
  segmentCount: document.querySelector("#segmentCount"),
  editorStatus: document.querySelector("#editorStatus"),
  segmentsList: document.querySelector("#segmentsList"),
  segmentTemplate: document.querySelector("#segmentTemplate"),
  saveButton: document.querySelector("#saveButton"),
  newProjectButton: document.querySelector("#newProjectButton"),
  prevSegmentButton: document.querySelector("#prevSegmentButton"),
  nextSegmentButton: document.querySelector("#nextSegmentButton"),
  addSegmentButton: document.querySelector("#addSegmentButton"),
  mergeButton: document.querySelector("#mergeButton"),
  splitButton: document.querySelector("#splitButton"),
};

nodes.createButton.addEventListener("click", createProject);
nodes.openRecentButton.addEventListener("click", openRecentProject);
nodes.saveButton.addEventListener("click", saveProject);
nodes.newProjectButton.addEventListener("click", resetProject);
nodes.audioPlayer.addEventListener("timeupdate", syncActiveSegment);
nodes.audioPlayer.addEventListener("loadedmetadata", syncActiveSegment);
nodes.searchInput.addEventListener("input", applyFilter);
nodes.rateInput.addEventListener("input", updatePlaybackRate);
nodes.prevSegmentButton.addEventListener("click", () => goToAdjacentSegment(-1, true));
nodes.nextSegmentButton.addEventListener("click", () => goToAdjacentSegment(1, true));
nodes.addSegmentButton.addEventListener("click", addSegmentAtCurrentTime);
nodes.mergeButton.addEventListener("click", mergeSelectedWithNext);
nodes.splitButton.addEventListener("click", splitSelectedAtCaret);
document.querySelectorAll("[data-export]").forEach((button) => {
  button.addEventListener("click", () => exportProject(button.dataset.export));
});
loadRecentProjects();

window.addEventListener("beforeunload", (event) => {
  if (!state.dirty) return;
  event.preventDefault();
  event.returnValue = "";
});

document.addEventListener("keydown", (event) => {
  if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return;
  event.preventDefault();
  if (!state.project || nodes.saveButton.disabled) return;
  saveProject();
});

async function createProject() {
  const audioFile = nodes.audioInput.files?.[0];
  const transcriptFile = nodes.transcriptInput.files?.[0];
  if (!audioFile || !transcriptFile) {
    setStatus("Choose both audio and transcript files.");
    return;
  }

  setBusy(true, "Reading transcript...");
  try {
    const transcriptText = await transcriptFile.text();
    const createResponse = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        audio_filename: audioFile.name,
        audio_type: audioFile.type,
        transcript_filename: transcriptFile.name,
        transcript_text: transcriptText,
      }),
    });
    if (!createResponse.ok) {
      throw new Error(await readError(createResponse));
    }
    const project = await createResponse.json();

    setBusy(true, "Uploading audio...");
    const audioResponse = await fetch(`/api/projects/${project.id}/audio`, {
      method: "PUT",
      headers: {
        "Content-Type": audioFile.type || "application/octet-stream",
        "X-Filename": encodeURIComponent(audioFile.name),
      },
      body: audioFile,
    });
    if (!audioResponse.ok) {
      throw new Error(await readError(audioResponse));
    }
    const uploadResult = await audioResponse.json();
    loadProject(uploadResult.project);
    loadRecentProjects();
    setStatus("Project loaded.");
  } catch (error) {
    setStatus(error.message || "Could not load project.");
  } finally {
    setBusy(false);
  }
}

function loadProject(project) {
  state.project = project;
  state.segments = normalizeSegments(project.segments || []);
  state.selectedId = state.segments[0]?.id ?? null;
  state.activeId = null;
  state.dirty = false;
  nodes.audioPlayer.src = `/api/projects/${project.id}/audio`;
  nodes.projectName.textContent = `${project.audio_filename} / ${project.transcript_filename}`;
  nodes.importPanel.classList.add("hidden");
  nodes.editorPanel.classList.remove("hidden");
  renderSegments();
  updateToolbar();
}

function resetProject() {
  state.project = null;
  state.segments = [];
  state.selectedId = null;
  state.activeId = null;
  state.dirty = false;
  nodes.audioPlayer.removeAttribute("src");
  nodes.audioPlayer.load();
  nodes.audioInput.value = "";
  nodes.transcriptInput.value = "";
  nodes.importPanel.classList.remove("hidden");
  nodes.editorPanel.classList.add("hidden");
  nodes.saveButton.disabled = true;
  setStatus("");
  loadRecentProjects();
}

async function loadRecentProjects() {
  try {
    const response = await fetch("/api/projects");
    if (!response.ok) return;
    const projects = await response.json();
    nodes.recentProjects.textContent = "";
    for (const project of projects) {
      const option = document.createElement("option");
      option.value = project.id;
      option.textContent = `${project.audio_filename || "audio"} / ${project.transcript_filename || "transcript"} (${project.segment_count})`;
      nodes.recentProjects.append(option);
    }
    nodes.recentPanel.classList.toggle("hidden", projects.length === 0);
  } catch {
    nodes.recentPanel.classList.add("hidden");
  }
}

async function openRecentProject() {
  const projectId = nodes.recentProjects.value;
  if (!projectId) return;
  setBusy(true, "Opening project...");
  try {
    const response = await fetch(`/api/projects/${projectId}`);
    if (!response.ok) {
      throw new Error(await readError(response));
    }
    loadProject(await response.json());
    setStatus("Project loaded.");
  } catch (error) {
    setStatus(error.message || "Could not open project.");
  } finally {
    setBusy(false);
  }
}

function renderSegments() {
  nodes.segmentsList.textContent = "";
  const speakers = getSpeakers();
  syncSpeakerColors(speakers);
  const fragment = document.createDocumentFragment();
  for (const segment of state.segments) {
    const row = nodes.segmentTemplate.content.firstElementChild.cloneNode(true);
    row.dataset.id = String(segment.id);
    applySpeakerColor(row, segment.speaker);
    row.classList.toggle("selected", segment.id === state.selectedId);
    row.classList.toggle("active", segment.id === state.activeId);
    populateSpeakerSelect(row.querySelector(".speaker-input"), speakers, segment.speaker);
    row.querySelector(".start-input").value = formatTime(segment.start);
    row.querySelector(".end-input").value = formatTime(segment.end);
    row.querySelector(".segment-text").value = segment.text;

    row.addEventListener("click", () => selectSegment(segment.id));
    row.querySelector(".play-segment").addEventListener("click", (event) => {
      event.stopPropagation();
      playFrom(segment.start);
      selectSegment(segment.id);
    });
    row.querySelector(".set-start").addEventListener("click", (event) => {
      event.stopPropagation();
      updateSegment(segment.id, { start: roundTime(nodes.audioPlayer.currentTime) });
    });
    row.querySelector(".set-end").addEventListener("click", (event) => {
      event.stopPropagation();
      updateSegment(segment.id, { end: roundTime(nodes.audioPlayer.currentTime) });
    });

    const startInput = row.querySelector(".start-input");
    const endInput = row.querySelector(".end-input");
    const speakerInput = row.querySelector(".speaker-input");
    const textInput = row.querySelector(".segment-text");

    speakerInput.addEventListener("focus", () => selectSegment(segment.id));
    speakerInput.addEventListener("change", () => {
      updateSegment(segment.id, { speaker: speakerInput.value }, false);
      renderSegments();
      scrollSelectedIntoView();
    });
    startInput.addEventListener("change", () => updateSegment(segment.id, { start: parseTime(startInput.value) }));
    endInput.addEventListener("change", () => updateSegment(segment.id, { end: parseTime(endInput.value) }));
    textInput.addEventListener("focus", () => selectSegment(segment.id));
    textInput.addEventListener("input", () => {
      updateSegment(segment.id, { text: textInput.value }, false);
      fitTextarea(textInput);
    });
    textInput.addEventListener("keydown", (event) => handleTextKeydown(event, segment.id));
    fitTextarea(textInput);

    fragment.append(row);
  }
  nodes.segmentsList.append(fragment);
  nodes.segmentsList.querySelectorAll(".segment-text").forEach(fitTextarea);
  nodes.segmentCount.textContent = `${state.segments.length} segments`;
  applyFilter();
  updateToolbar();
}

function getSpeakers() {
  const speakers = [];
  for (const segment of state.segments) {
    const speaker = segment.speaker.trim();
    if (speaker && !speakers.includes(speaker)) {
      speakers.push(speaker);
    }
  }
  return speakers;
}

function populateSpeakerSelect(select, speakers, currentSpeaker) {
  select.textContent = "";
  const emptyOption = document.createElement("option");
  emptyOption.value = "";
  emptyOption.textContent = "No speaker";
  select.append(emptyOption);

  const options = [...speakers];
  if (currentSpeaker && !options.includes(currentSpeaker)) {
    options.push(currentSpeaker);
  }
  for (const speaker of options) {
    const option = document.createElement("option");
    option.value = speaker;
    option.textContent = speaker;
    select.append(option);
  }
  select.value = currentSpeaker || "";
}

function syncSpeakerColors(speakers) {
  const next = new Map();
  speakers.forEach((speaker, index) => {
    next.set(speaker, state.speakerColors.get(speaker) || speakerPalette[index % speakerPalette.length]);
  });
  state.speakerColors = next;
}

function applySpeakerColor(row, speaker) {
  const color = state.speakerColors.get(speaker);
  if (!color) return;
  row.style.setProperty("--speaker-bg", color.bg);
  row.style.setProperty("--speaker-active-bg", color.active);
  row.style.setProperty("--speaker-border", color.border);
  row.classList.add("has-speaker");
}

function selectSegment(id) {
  state.selectedId = id;
  document.querySelectorAll(".segment-row").forEach((row) => {
    row.classList.toggle("selected", Number(row.dataset.id) === id);
  });
  updateToolbar();
}

function handleTextKeydown(event, id) {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    selectSegment(id);
    goToAdjacentSegment(1, true);
  }
  if ((event.metaKey || event.ctrlKey) && event.key === "ArrowDown") {
    event.preventDefault();
    selectSegment(id);
    goToAdjacentSegment(1, false);
  }
  if ((event.metaKey || event.ctrlKey) && event.key === "ArrowUp") {
    event.preventDefault();
    selectSegment(id);
    goToAdjacentSegment(-1, false);
  }
}

function updateSegment(id, patch, rerender = true) {
  const segment = state.segments.find((item) => item.id === id);
  if (!segment) return;
  Object.assign(segment, patch);
  if (segment.end < segment.start) {
    segment.end = segment.start;
  }
  state.segments = normalizeSegments(state.segments);
  markDirty();
  if (rerender) {
    renderSegments();
    scrollSelectedIntoView();
  }
}

function markDirty() {
  state.dirty = true;
  nodes.saveButton.disabled = false;
  setStatus("Unsaved changes.");
}

async function saveProject() {
  if (!state.project) return;
  setStatus("Saving...");
  const response = await fetch(`/api/projects/${state.project.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ segments: state.segments }),
  });
  if (!response.ok) {
    setStatus(await readError(response));
    return;
  }
  state.project = await response.json();
  state.segments = normalizeSegments(state.project.segments || []);
  state.dirty = false;
  nodes.saveButton.disabled = true;
  renderSegments();
  setStatus("Saved.");
}

function addSegmentAtCurrentTime() {
  const current = roundTime(nodes.audioPlayer.currentTime || 0);
  const selectedIndex = selectedIndexOrLastBefore(current);
  const next = state.segments[selectedIndex + 1];
  const end = next ? Math.max(current + 0.5, next.start) : current + 3;
  const segment = {
    id: state.segments.length + 1,
    start: current,
    end,
    speaker: state.segments[selectedIndex]?.speaker || "",
    text: "",
  };
  state.segments.splice(selectedIndex + 1, 0, segment);
  state.segments = normalizeSegments(state.segments);
  state.selectedId = findSegmentIdByShape(segment, selectedIndex + 1);
  markDirty();
  renderSegments();
  scrollSelectedIntoView();
  focusSelectedText(0);
}

function selectedIndexOrLastBefore(time) {
  const selectedIndex = state.segments.findIndex((segment) => segment.id === state.selectedId);
  if (selectedIndex >= 0) return selectedIndex;
  let index = state.segments.findIndex((segment) => segment.start > time);
  return index > 0 ? index - 1 : state.segments.length - 1;
}

function mergeSelectedWithNext() {
  const index = state.segments.findIndex((segment) => segment.id === state.selectedId);
  if (index < 0 || index >= state.segments.length - 1) return;
  const current = state.segments[index];
  const next = state.segments[index + 1];
  current.end = Math.max(current.end, next.end);
  current.text = `${current.text.trim()} ${next.text.trim()}`.trim();
  state.segments.splice(index + 1, 1);
  state.segments = normalizeSegments(state.segments);
  state.selectedId = current.id;
  markDirty();
  renderSegments();
  scrollSelectedIntoView();
}

function splitSelectedAtCaret() {
  const index = state.segments.findIndex((segment) => segment.id === state.selectedId);
  if (index < 0) return;
  const row = document.querySelector(`.segment-row[data-id="${state.selectedId}"]`);
  const textarea = row?.querySelector(".segment-text");
  if (!textarea) return;
  const caret = textarea.selectionStart ?? 0;
  const text = textarea.value;
  const left = text.slice(0, caret).trim();
  const right = text.slice(caret).trim();
  if (!left || !right) return;

  const segment = state.segments[index];
  const originalEnd = segment.end;
  const midpoint = roundTime((segment.start + segment.end) / 2);
  segment.text = left;
  segment.end = midpoint;
  const inserted = {
    id: state.segments.length + 1,
    start: midpoint,
    end: Math.max(midpoint, originalEnd),
    speaker: segment.speaker,
    text: right,
  };
  state.segments.splice(index + 1, 0, inserted);
  state.segments = normalizeSegments(state.segments);
  state.selectedId = findSegmentIdByShape(inserted, index + 1);
  markDirty();
  renderSegments();
  scrollSelectedIntoView();
  focusSelectedText(0);
}

function playFrom(seconds) {
  nodes.audioPlayer.currentTime = Math.max(0, seconds);
  nodes.audioPlayer.play();
}

function goToAdjacentSegment(direction, shouldPlay) {
  const index = state.segments.findIndex((segment) => segment.id === state.selectedId);
  if (index < 0) return;
  const nextIndex = index + direction;
  if (nextIndex < 0 || nextIndex >= state.segments.length) return;
  const segment = state.segments[nextIndex];
  state.selectedId = segment.id;
  renderSegments();
  scrollSelectedIntoView();
  focusSelectedText();
  if (shouldPlay) {
    playFrom(segment.start);
  }
}

function syncActiveSegment() {
  const time = nodes.audioPlayer.currentTime || 0;
  nodes.currentTime.textContent = formatTime(time);
  const active = state.segments.find((segment) => time >= segment.start && time <= segment.end);
  const activeId = active?.id ?? null;
  if (activeId === state.activeId) return;
  state.activeId = activeId;
  document.querySelectorAll(".segment-row").forEach((row) => {
    const isActive = Number(row.dataset.id) === activeId;
    row.classList.toggle("active", isActive);
    if (isActive && document.activeElement?.tagName !== "TEXTAREA") {
      row.scrollIntoView({ block: "nearest" });
    }
  });
}

function updatePlaybackRate() {
  const value = Number(nodes.rateInput.value);
  nodes.audioPlayer.playbackRate = value;
  nodes.rateOutput.textContent = `${value.toFixed(2)}x`;
}

function applyFilter() {
  const query = nodes.searchInput.value.trim().toLowerCase();
  document.querySelectorAll(".segment-row").forEach((row) => {
    const segment = state.segments.find((item) => item.id === Number(row.dataset.id));
    const searchable = `${segment?.speaker || ""} ${segment?.text || ""}`.toLowerCase();
    const visible = !query || searchable.includes(query);
    row.classList.toggle("filtered-out", !visible);
  });
}

async function exportProject(format) {
  if (!state.project) return;
  if (state.dirty) {
    await saveProject();
  }
  window.location.href = `/api/projects/${state.project.id}/export/${format}`;
}

function updateToolbar() {
  const index = state.segments.findIndex((segment) => segment.id === state.selectedId);
  nodes.prevSegmentButton.disabled = index <= 0;
  nodes.nextSegmentButton.disabled = index < 0 || index >= state.segments.length - 1;
  nodes.mergeButton.disabled = index < 0 || index >= state.segments.length - 1;
  nodes.splitButton.disabled = index < 0;
}

function focusSelectedText(caretPosition = null) {
  const row = document.querySelector(`.segment-row[data-id="${state.selectedId}"]`);
  const textarea = row?.querySelector(".segment-text");
  textarea?.focus();
  if (textarea && caretPosition !== null) {
    textarea.setSelectionRange(caretPosition, caretPosition);
  }
}

function fitTextarea(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = `${Math.max(52, textarea.scrollHeight)}px`;
}

function findSegmentIdByShape(target, fallbackIndex) {
  const index = state.segments.findIndex(
    (segment) =>
      segment.start === target.start &&
      segment.end === target.end &&
      segment.speaker === target.speaker &&
      segment.text === target.text
  );
  if (index >= 0) return state.segments[index].id;
  const boundedIndex = Math.max(0, Math.min(fallbackIndex, state.segments.length - 1));
  return state.segments[boundedIndex]?.id ?? null;
}

function scrollSelectedIntoView() {
  const row = document.querySelector(`.segment-row[data-id="${state.selectedId}"]`);
  row?.scrollIntoView({ block: "nearest" });
}

function normalizeSegments(segments) {
  return segments
    .map((segment, index) => ({
      id: index + 1,
      start: roundTime(Number(segment.start) || 0),
      end: roundTime(Number(segment.end) || Number(segment.start) || 0),
      speaker: String(segment.speaker || ""),
      text: String(segment.text || ""),
    }))
    .sort((a, b) => a.start - b.start)
    .map((segment, index) => ({ ...segment, id: index + 1 }));
}

function parseTime(value) {
  const clean = String(value).trim().replace(",", ".");
  if (!clean) return 0;
  const parts = clean.split(":").map(Number);
  if (parts.some(Number.isNaN)) return Number(clean) || 0;
  if (parts.length === 3) return roundTime(parts[0] * 3600 + parts[1] * 60 + parts[2]);
  if (parts.length === 2) return roundTime(parts[0] * 60 + parts[1]);
  return roundTime(parts[0]);
}

function formatTime(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const secs = Math.floor(value % 60);
  const millis = Math.round((value - Math.floor(value)) * 1000);
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)},${String(millis).padStart(3, "0")}`;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function roundTime(value) {
  return Math.max(0, Math.round(Number(value) * 1000) / 1000);
}

function setBusy(isBusy, message = "") {
  nodes.createButton.disabled = isBusy;
  nodes.createButton.textContent = isBusy ? "Loading..." : "Load editor";
  if (message) setStatus(message);
}

function setStatus(message) {
  nodes.importStatus.textContent = message;
  nodes.editorStatus.textContent = message;
}

async function readError(response) {
  try {
    const payload = await response.json();
    return payload.detail || response.statusText;
  } catch {
    return response.statusText;
  }
}
