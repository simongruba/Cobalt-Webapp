"use strict";
const $ = (s) => document.querySelector(s),
  $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const KEY = "cobalt-class-v1";
const initial = () => ({
  students: [],
  officers: [],
  birthdays: [],
  hero: [null, null],
  albums: [],
  achievements: [],
  messages: [
    {
      id: "welcome",
      name: "Your Cobalt classroom",
      text: "Here’s to the little moments that become our favorite memories. This space is ours. ♡",
      color: "#d6eaff",
      date: "Welcome",
      image: null,
    },
  ],
  deck: [],
  last: null,
});
let state;
try {
  state = JSON.parse(localStorage.getItem(KEY)) || initial();
} catch {
  state = initial();
}
// Import the supplied roster once while preserving locally added photos and quotes.
function mergeClassRoster(target, roster) {
  const canonical = (name) =>
    name
      .normalize("NFKC")
      .toLocaleLowerCase()
      .replace(/\s*,\s*/g, ",")
      .replace(/\s+/g, " ")
      .trim();
  for (const student of target.students) {
    if (student.gender === "Boys") student.gender = "Males";
    if (student.gender === "Girls") student.gender = "Females";
  }
  for (const student of roster) {
    if (
      (target.deletedStudents || []).some(
        (s) =>
          s.id === student.id || canonical(s.name) === canonical(student.name),
      )
    )
      continue;
    const existing = target.students.find(
      (s) =>
        s.id === student.id || canonical(s.name) === canonical(student.name),
    );
    if (existing) {
      existing.gender = student.gender;
    } else target.students.push(JSON.parse(JSON.stringify(student)));
  }
  target.adviser ??= { name: "", message: "", image: null };
  target.officers ??= [];
  target.birthdays ??= [];
  target.rosterVersion = 1;
}
mergeClassRoster(state, window.COBALT_ROSTER || []);
const legacyClassroom = JSON.parse(JSON.stringify(state));
let cloudReady = false;
let cloudBusy = false;
let cloudLoading = false;
let cloudRevision = null;
let cloudLoadVersion = 0;
const clone = (value) => JSON.parse(JSON.stringify(value));

function emptyClassroom() {
  const value = initial();
  value.achievements = [];
  value.adviser = { name: "", message: "", image: null };
  return value;
}
state = emptyClassroom();

let user = null,
  messagePage = 0,
  albumPage = 0,
  toastTimer,
  studentQuery = "",
  authBusy = false;

// Supabase photo files are stored in this public bucket.
// Only permanent file paths are saved in classroom state.
const COBALT_MEDIA_BUCKET = "cobalt-media";
const photoUrls = new Map();
let sessionVersion = 0;

function imageSource(image) {
  if (!image) return "";
  if (!image.storagePath) return image.src || "";
  const { data } = supabaseClient.storage
    .from(COBALT_MEDIA_BUCKET)
    .getPublicUrl(image.storagePath);
  return data.publicUrl;
}

// Public images have permanent URLs; they do not need signed-link renewal.
async function refreshPhotoUrls() {
  photoUrls.clear();
}

async function restoreCobaltSession() {
  if (cloudBusy || cloudLoading || authBusy || $("#modal").open) return;
  const version = sessionVersion;
  try {
    const restored = await CobaltAuth.getCurrentUser();
    if (version !== sessionVersion) return;
    if (user?.id !== restored?.id) {
      state = emptyClassroom();
      cloudReady = false;
      photoUrls.clear();
    }
    user = restored;
    await loadClassroom();
    await refreshPhotoUrls();
    render();
  } catch (error) {
    console.error("Cobalt loading:", error.message);
    toast(error.message);
  }
}

const admin = () => user?.role === "admin";
function toast(message) {
  $("#toast").textContent = message;
  $("#toast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("#toast").classList.remove("show"), 3500);
}
const uid = () => crypto.randomUUID();

function classroomContent(value) {
  const content = clone(value);
  delete content.deck;
  delete content.last;
  return content;
}

function applyCloudRow(row) {
  const deck = state.deck || [];
  const last = state.last ?? null;
  state = { ...emptyClassroom(), ...clone(row.content), deck, last };
  cloudRevision = row.revision;
  cloudReady = true;
}

function photoPaths(value, paths = new Set()) {
  if (!value || typeof value !== "object") return paths;
  if (typeof value.storagePath === "string") paths.add(value.storagePath);
  for (const child of Object.values(value)) photoPaths(child, paths);
  return paths;
}

async function flushFileCleanup() {
  if (!admin()) return;
  const { data: jobs, error } = await supabaseClient
    .from("cobalt_file_cleanup")
    .select("path")
    .limit(1000);
  if (error) throw new Error(error.message);
  for (const job of jobs || []) {
    const { data: inUse, error: usageError } = await supabaseClient.rpc(
      "cobalt_photo_in_use",
      { photo_path: job.path },
    );
    if (usageError) throw new Error(usageError.message);
    if (!inUse) {
      const { error: removalError } = await supabaseClient.storage
        .from(COBALT_MEDIA_BUCKET)
        .remove([job.path]);
      if (removalError) throw new Error(removalError.message);
      // The Storage API may return success with no deletion when RLS denies it.
      const slash = job.path.lastIndexOf("/");
      const { data: remaining, error: listError } = await supabaseClient.storage
        .from(COBALT_MEDIA_BUCKET)
        .list(job.path.slice(0, slash), {
          search: job.path.slice(slash + 1),
          limit: 100,
        });
      if (listError) throw new Error(listError.message);
      if (
        (remaining || []).some(
          (file) => file.name === job.path.slice(slash + 1),
        )
      ) {
        throw new Error(
          "A photo could not be deleted. Check the Storage delete policy.",
        );
      }
      photoUrls.delete(job.path);
    }
    const { error: queueError } = await supabaseClient
      .from("cobalt_file_cleanup")
      .delete()
      .eq("path", job.path);
    if (queueError) throw new Error(queueError.message);
  }
}

async function migrateBrowserPhotos(value) {
  if (!value || typeof value !== "object") return;
  if (
    !value.storagePath &&
    typeof value.src === "string" &&
    value.src.startsWith("data:image/")
  ) {
    const blob = await (await fetch(value.src)).blob();
    const uploaded = await readImage(
      new File([blob], "imported-photo", { type: blob.type }),
    );
    delete value.src;
    value.storagePath = uploaded.storagePath;
  }
  for (const child of Object.values(value)) await migrateBrowserPhotos(child);
}

async function loadClassroom() {
  const generation = ++cloudLoadVersion;
  if (!supabaseClient) {
    state = clone(legacyClassroom);
    state.achievements ??= [];
    cloudReady = false;
    return;
  }
  cloudLoading = true;
  try {
    let { data, error } = await supabaseClient
      .from("cobalt_classroom_content")
      .select("content,revision")
      .eq("id", 1)
      .maybeSingle();
    if (error)
      throw new Error(
        `Classroom could not load. Run 1-setup.sql first. ${error.message}`,
      );
    if (generation !== cloudLoadVersion) return;
    if (!data && admin()) {
      // Keep a local recovery copy before the first migration.
      localStorage.setItem(
        KEY + "-before-cloud",
        JSON.stringify(legacyClassroom),
      );
      const seed = classroomContent(legacyClassroom);
      toast("Saving your existing classroom to Supabase…");
      await migrateBrowserPhotos(seed);
      const inserted = await supabaseClient
        .from("cobalt_classroom_content")
        .insert({ id: 1, content: seed })
        .select("content,revision")
        .single();
      if (inserted.error) {
        // Another admin may have initialized it while this tab was uploading.
        const existing = await supabaseClient
          .from("cobalt_classroom_content")
          .select("content,revision")
          .eq("id", 1)
          .maybeSingle();
        if (existing.error || !existing.data)
          throw new Error(inserted.error.message);
        data = existing.data;
      } else data = inserted.data;
    }
    if (!data)
      throw new Error(
        "Your adviser must sign in once to initialize the classroom.",
      );
    if (generation !== cloudLoadVersion) return;
    applyCloudRow(data);
    try {
      await flushFileCleanup();
    } catch (error) {
      toast(`Photo cleanup needs a retry: ${error.message}`);
    }
  } finally {
    if (generation === cloudLoadVersion) cloudLoading = false;
  }
}

async function commit(change) {
  if (!admin() || !cloudReady) {
    toast("Sign in as admin and wait for the classroom to load.");
    return false;
  }
  if (cloudBusy || cloudLoading) {
    toast("Please wait for the current save to finish.");
    return false;
  }
  cloudBusy = true;
  const before = clone(state);
  let saved = false;
  try {
    change();
    const { data, error } = await supabaseClient
      .from("cobalt_classroom_content")
      .update({ content: classroomContent(state) })
      .eq("id", 1)
      .eq("revision", cloudRevision)
      .select("content,revision")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) {
      state = before;
      await loadClassroom();
      throw new Error(
        "The classroom changed in another tab. The latest version is loaded; please repeat your edit.",
      );
    }
    saved = true;
    applyCloudRow(data);
    await flushFileCleanup();
    await refreshPhotoUrls();
    render();
    return true;
  } catch (error) {
    if (!saved && cloudRevision === null) state = before;
    else if (!saved) {
      // Reconcile uncertain network results before another edit.
      state = before;
      try {
        await loadClassroom();
      } catch {
        cloudReady = false;
      }
    }
    render();
    modal(
      saved ? "Saved — photo cleanup needs a retry" : "Change not confirmed",
      `
      <p>${esc(error.message)}</p>
      <p>${saved ? "The classroom change is saved. Pending file deletions will retry when you refresh while signed in as admin." : "Please check the current classroom before trying again."}</p>
    `,
    );
    return false;
  } finally {
    cloudBusy = false;
  }
}

async function postClassMessage(note) {
  if (!cloudReady || cloudBusy)
    throw new Error("Please wait for the classroom to load or finish saving.");
  if (!user || !["student", "admin"].includes(user.role))
    throw new Error("Your account must be approved to post messages.");
  cloudBusy = true;
  try {
    const { data, error } = await supabaseClient.rpc("cobalt_post_message", {
      request_id: note.id,
      note_text: note.text,
      note_color: note.color,
      photo_path: note.image?.storagePath || null,
    });
    if (error) throw new Error(error.message);
    applyCloudRow(Array.isArray(data) ? data[0] : data);
    await refreshPhotoUrls();
    render();
    return true;
  } finally {
    cloudBusy = false;
  }
}

let modalReturnScrollY = null;
// Popup history behaves like a small browser back stack.
// Example: View all students → student profile → Close → View all students.
const modalHistory = [];
let modalRestore = null;
let restoringModal = false;

function modal(title, html, options = {}) {
  const dialog = $("#modal");
  if (!dialog.open) modalReturnScrollY = window.scrollY;

  if (dialog.open && modalRestore && !restoringModal && !options.replace) {
    modalHistory.push(modalRestore);
  }

  modalRestore = options.restore || null;
  dialog.dataset.dismiss = "normal";
  dialog.classList.remove("image-viewer-modal", "mini-profile-modal");
  $("#modal-title").textContent = title;
  $("#modal-content").innerHTML = html;
  if (!dialog.open) dialog.showModal();
  document.body.classList.add("modal-open");
}

function close() {
  if (authBusy) return;
  if (modalHistory.length) {
    const restore = modalHistory.pop();
    modalRestore = null;
    restoringModal = true;
    try {
      restore();
    } finally {
      restoringModal = false;
    }
    return;
  }
  modalRestore = null;
  $("#modal").close();
}
$("#close-modal").onclick = close;
$("#modal").addEventListener("cancel", (e) => {
  if (authBusy || $("#modal").dataset.dismiss === "explicit") {
    e.preventDefault();
    return;
  }
  if (modalHistory.length) {
    e.preventDefault();
    close();
  }
});
$("#modal").addEventListener("close", () => {
  document.body.classList.remove("modal-open");
  modalHistory.length = 0;
  modalRestore = null;
  if (modalReturnScrollY !== null) {
    const y = modalReturnScrollY;
    modalReturnScrollY = null;
    requestAnimationFrame(() =>
      window.scrollTo({ top: y, left: 0, behavior: "auto" }),
    );
  }
});
$("#modal").addEventListener("click", (e) => {
  if (e.target === $("#modal") && $("#modal").dataset.dismiss !== "explicit") {
    const r = e.target.getBoundingClientRect();
    if (
      e.clientX < r.left ||
      e.clientX > r.right ||
      e.clientY < r.top ||
      e.clientY > r.bottom
    )
      close();
  }
});
function guard() {
  if (admin()) {
    if (!cloudReady || cloudBusy || cloudLoading) {
      toast("Please wait for the classroom to finish loading or saving.");
      return false;
    }
    return true;
  }
  modal(
    "A little space for your adviser",
    /* HTML */ `
      <p>Only the admin can make this change.</p>
      <button class="pill" id="guard-signin">Sign in</button>
    `,
  );
  $("#guard-signin").onclick = login;
  return false;
}
function login(mode = "signin", prefill = "") {
  const creating = mode === "register";
  modal(
    creating ? "Join the Cobalt classroom" : "Welcome back to Cobalt",
    /* HTML */ `
      <div class="auth-tabs">
        <button
          type="button"
          id="show-signin"
          class="${creating ? "outline" : "pill"}"
          aria-pressed="${!creating}"
        >
          Sign in
        </button>
        <button
          type="button"
          id="show-register"
          class="${creating ? "pill" : "outline"}"
          aria-pressed="${creating}"
        >
          Create account
        </button>
      </div>
      <p class="hint">
        ${creating
          ? "Create your classmate account to leave messages for the class."
          : "Use the email and password for your existing account."}
      </p>
      <form id="login-form">
        <fieldset class="auth-fields">
          <label class="field">
            Email address
            <input
              name="email"
              type="email"
              required
              maxlength="254"
              autocomplete="email"
              autocapitalize="none"
              spellcheck="false"
              value="${esc(prefill)}"
            />
          </label>
          ${creating
            ? `
            <label class="field">
              Username
              <input
                name="username"
                required
                minlength="3"
                maxlength="32"
                pattern="(?:[A-Za-z0-9._]|-){3,32}"
                autocomplete="username"
                autocapitalize="none"
                spellcheck="false"
              />
            </label>
            <p class="hint">Your username will appear in the classroom. Your email is used to sign in.</p>
          `
            : ""}
          <label class="field">
            Password
            <input
              name="password"
              type="password"
              required
              ${creating ? 'minlength="8"' : ""}
              maxlength="128"
              autocomplete="${creating ? "new-password" : "current-password"}"
            />
          </label>
          ${creating
            ? '<label class="field">Confirm password<input name="confirmation" type="password" required minlength="8" maxlength="128" autocomplete="new-password"></label><p class="hint">Use at least 8 characters. Your account is saved in Supabase. Confirm your email if requested.</p>'
            : ""}
          <p id="auth-error" class="auth-error" role="alert"></p>
          <button type="submit" class="pill" id="auth-submit">
            ${creating ? "Create account" : "Sign in"} ↗
          </button>
        </fieldset>
      </form>
    `,
  );
  $("#show-signin").onclick = () => login("signin");
  $("#show-register").onclick = () => login("register");
  $("#modal").dataset.dismiss = "explicit";
  const f = $("#login-form");
  f.onsubmit = async (e) => {
    e.preventDefault();
    if (f.dataset.busy) return;
    const input = {
      email: f.elements.email.value,
      password: f.elements.password.value,
    };
    if (creating) {
      input.username = f.elements.username.value;
      input.confirmation = f.elements.confirmation.value;
    }
    const submit = $("#auth-submit");
    f.dataset.busy = "true";
    f.querySelector("fieldset").disabled = true;
    $("#auth-error").textContent = "";
    submit.innerHTML =
      '<span class="button-spinner" aria-hidden="true"></span> ' +
      (creating ? "Creating account…" : "Signing in…");
    try {
      const result = creating
        ? await CobaltAuth.register(input)
        : await CobaltAuth.signIn(input);
      if (!f.isConnected || !$("#modal").open) return;
      if (creating) {
        modal(
          "Your account is ready",
          /* HTML */ `
            <div class="session-state">
              <span class="session-check" aria-hidden="true">✓</span>
              <h3>Welcome to Cobalt!</h3>
              <p>
                Your username is
                <strong>${esc(result.username)}</strong>
                . Check your email for a confirmation link if one was sent, then
                sign in using your email address and password.
              </p>
              <button class="pill" id="account-ready">
                Sign in to my account
              </button>
            </div>
          `,
        );
        $("#account-ready").onclick = () => login("signin", result.email);
      } else await changeSession(result);
    } catch (error) {
      if (f.isConnected && $("#modal").open)
        $("#auth-error").textContent = error.message;
    } finally {
      delete f.dataset.busy;
      f.querySelector("fieldset").disabled = false;
      submit.textContent = creating ? "Create account ↗" : "Sign in ↗";
    }
  };
}
function account() {
  document.body.classList.toggle("is-admin", admin());
  $("#account").innerHTML = user
    ? /* HTML */ `
        <button id="user-menu" class="pill" aria-expanded="false">
          ${esc(user.name)} ⌄
        </button>
        <button id="logout" hidden>Log out</button>
      `
    : /* HTML */ ` <button id="login" class="pill">Sign in ↗</button> `;
  if (!user) $("#login").onclick = login;
  else {
    $("#user-menu").onclick = () => {
      const b = $("#logout");
      b.hidden = !b.hidden;
      $("#user-menu").setAttribute("aria-expanded", String(!b.hidden));
    };
    $("#logout").onclick = () => changeSession(null);
  }
}
function media(image, label = "Your photo here") {
  return imageSource(image)
    ? /* HTML */ `
        <img
          class="media-image"
          src="${esc(imageSource(image))}"
          alt="${esc(label)}"
          style="transform:scale(${Number(image.zoom) ||
          1});object-position:${Number(image.x) ?? 50}% ${Number(image.y) ??
          50}%"
        />
      `
    : /* HTML */ `
        <span class="placeholder">
          <span class="symbol">◇</span>
          <small>${esc(label)}</small>
        </span>
      `;
}
function mediaTools(key, image, allowCrop = true) {
  return admin()
    ? /* HTML */ `
        <div class="admin-tools">
          <button data-media="${esc(key)}">
            ${image ? "Replace" : "Upload"} photo
          </button>
          ${image
            ? `${
                allowCrop
                  ? /* HTML */ `
                      <button data-resize="${esc(key)}">Resize / crop</button>
                    `
                  : ""
              }<button data-remove="${esc(key)}">Delete photo</button>`
            : ""}
        </div>
      `
    : "";
}
function resolveMedia(key) {
  const [type, id, index] = key.split(":");
  if (type === "adviser")
    return {
      get: () => state.adviser.image,
      set: (v) => (state.adviser.image = v),
    };
  if (type === "hero")
    return { get: () => state.hero[+id], set: (v) => (state.hero[+id] = v) };
  if (type === "student") {
    const s = state.students.find((s) => s.id === id);
    return { get: () => s.images[+index], set: (v) => (s.images[+index] = v) };
  }
  if (type === "album") {
    const a = state.albums.find((a) => a.id === id);
    return {
      get: () => a.images.find((i) => i.id === index),
      set: (v) => {
        const n = a.images.findIndex((i) => i.id === index);
        if (v) a.images[n] = { ...v, id: index };
        else a.images.splice(n, 1);
      },
    };
  }
  if (type === "achievement") {
    const item = state.achievements.find((value) => value.id === id);
    return { get: () => item.image, set: (value) => (item.image = value) };
  }
  if (type === "message") {
    const m = state.messages.find((m) => m.id === id);
    return { get: () => m.image, set: (v) => (m.image = v) };
  }
}
async function readImage(file) {
  if (!file || !["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    throw new Error("Choose a JPG, PNG or WebP photo.");
  }
  if (file.size > 5 * 1024 * 1024) {
    throw new Error("Please choose a photo no larger than 5 MB.");
  }

  const current = await CobaltAuth.getCurrentUser();
  if (!current) throw new Error("Please sign in before uploading a photo.");
  if (!["admin", "student"].includes(current.role)) {
    throw new Error("Your account must be approved before uploading photos.");
  }

  const version = sessionVersion;
  const extension = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
  }[file.type];
  const path = `${current.id}/${crypto.randomUUID()}.${extension}`;
  toast("Uploading photo…");

  const bucket = supabaseClient.storage.from(COBALT_MEDIA_BUCKET);
  const { error } = await bucket.upload(path, file, {
    contentType: file.type,
    upsert: false,
  });
  if (error) throw new Error(`Photo upload failed: ${error.message}`);

  if (version !== sessionVersion) {
    throw new Error("Your sign-in changed during upload. Please try again.");
  }
  toast("Photo uploaded to Supabase.");
  return { storagePath: path, zoom: 1, x: 50, y: 50 };
}
function pickImage(callback, multiple = false) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/png,image/jpeg,image/webp";
  input.multiple = multiple;
  input.onchange = async () => {
    try {
      const images = [];
      for (const file of input.files) images.push(await readImage(file));
      await callback(multiple ? images : images[0]);
    } catch (e) {
      toast(e.message);
    }
  };
  input.click();
}
function refreshDetail(key) {
  const [type, id] = key.split(":");
  if (type === "hero") {
    if ($("#modal").open) close();
  } else if (type === "adviser") adviserDetail();
  else if (type === "student") studentDetail(id);
  else if (type === "album") albumDetail(id);
  else if (type === "message") messageDetail(id);
  else if (type === "achievement") achievementDetail(id);
  else if ($("#modal").open) close();
}
function cropImage(key) {
  if (!guard()) return;
  const im = resolveMedia(key).get();
  modal(
    "Make it picture perfect",
    /* HTML */ `
      <div
        class="detail-photo ${key.startsWith("hero:")
          ? "home-crop-preview"
          : ""}"
        id="crop-preview"
      >
        ${media(im)}
      </div>
      <form id="crop-form">
        <label class="field">
          Zoom
          <input
            type="range"
            name="zoom"
            min="1"
            max="3"
            step=".05"
            value="${im.zoom || 1}"
          />
        </label>
        <label class="field">
          Horizontal position
          <input
            type="range"
            name="x"
            min="0"
            max="100"
            value="${im.x ?? 50}"
          />
        </label>
        <label class="field">
          Vertical position
          <input
            type="range"
            name="y"
            min="0"
            max="100"
            value="${im.y ?? 50}"
          />
        </label>
        <button class="pill">Save photo</button>
      </form>
    `,
  );
  const f = $("#crop-form");
  f.oninput = () =>
    ($("#crop-preview").innerHTML = media({
      ...im,
      zoom: +f.zoom.value,
      x: +f.x.value,
      y: +f.y.value,
    }));
  f.onsubmit = async (e) => {
    e.preventDefault();
    if (!guard()) return;
    if (
      await commit(() =>
        resolveMedia(key).set({
          ...im,
          zoom: +f.zoom.value,
          x: +f.x.value,
          y: +f.y.value,
        }),
      )
    )
      refreshDetail(key);
  };
}
function confirmDelete(action) {
  modal(
    "Delete this item?",
    /* HTML */ `
      <p>
        This removes it from the shared classroom and deletes any photo files no
        longer used.
      </p>
      <div class="actions">
        <button class="outline" id="cancel-delete">Keep it</button>
        <button class="pill" id="confirm-delete">Delete</button>
      </div>
    `,
  );
  $("#cancel-delete").onclick = close;
  $("#confirm-delete").onclick = async () => {
    if (guard()) {
      await action();
    }
  };
}
function renderHero() {
  $("#class-front").innerHTML = media(state.hero[0], "Our Cobalt class photo");
  $("#hero-tools").innerHTML = admin()
    ? mediaTools("hero:0", state.hero[0])
    : "";
}

// Each visit has a varied preview; both the preview and full directory stay alphabetical.
const studentPreviewOrder = new Map();
function previewStudents(list) {
  for (const student of list) {
    if (!studentPreviewOrder.has(student.id))
      studentPreviewOrder.set(student.id, Math.random());
  }
  return [...list]
    .sort(
      (a, b) => studentPreviewOrder.get(a.id) - studentPreviewOrder.get(b.id),
    )
    .slice(0, 5)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function studentCard(s) {
  const index = state.students.findIndex((item) => item.id === s.id);
  const hue = Math.round((index * 137.508 + 95) % 360);
  return /* HTML */ `
    <button
      class="student-card"
      style="--student-color:hsl(${hue} 63% 64%);--student-tint:hsl(${hue} 80% 94%)"
      data-student="${s.id}"
      title="${esc(s.name)}"
    >
      <div class="student-photo">${media(s.images[0], s.name)}</div>
      <h4>${esc(s.name)}</h4>
      <p class="student-quote">
        ${esc(s.quote || "A story waiting to be told.")}
      </p>
    </button>
  `;
}
function filteredStudents(group, query = "") {
  const normalize = (s) =>
    s
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase();
  const words = normalize(query).trim().split(/\s+/).filter(Boolean);
  return state.students
    .filter(
      (s) =>
        s.gender === group && words.every((w) => normalize(s.name).includes(w)),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}
function studentsHTML(all = false, query = studentQuery) {
  return ["Males", "Females"]
    .map((g) => {
      const list = filteredStudents(g, query),
        searching = Boolean(query.trim());
      return /* HTML */ `
        <div class="student-group">
          <h3>
            ${g}
            <span>/ ${String(list.length).padStart(2, "0")}</span>
          </h3>
          <div class="student-grid ${searching ? "search-results-grid" : ""}">
            ${list.length
              ? (all || searching ? list : previewStudents(list))
                  .map(studentCard)
                  .join("")
              : /* HTML */ `
                  <div class="empty">
                    ${searching
                      ? "No matching students in this group."
                      : "Your adviser can add students to this group."}
                  </div>
                `}
          </div>
        </div>
      `;
    })
    .join("");
}
function renderStudents() {
  $("#students").innerHTML = studentsHTML();
  const total = ["Males", "Females"].reduce(
    (n, g) => n + filteredStudents(g, studentQuery).length,
    0,
  );
  $("#student-results").textContent = studentQuery.trim()
    ? `${total} matching ${total === 1 ? "student" : "students"}`
    : `${state.students.length} classmates`;
  $("#clear-student-search").hidden = !studentQuery;
}
function addStudent() {
  if (!guard()) return;
  modal(
    "Another gem in our class",
    /* HTML */ `
      <form id="student-form">
        <label class="field">
          Student name
          <input name="studentName" maxlength="80" required />
        </label>
        <label class="field">
          Group
          <select name="gender">
            <option>Males</option>
            <option>Females</option>
          </select>
        </label>
        <button class="pill">Add student</button>
      </form>
    `,
  );
  $("#student-form").onsubmit = async (e) => {
    e.preventDefault();
    if (!guard()) return;
    const f = e.target,
      name = f.studentName.value.trim();
    if (!name) return toast("Please enter a student name.");
    const id = uid();
    if (
      await commit(() =>
        state.students.push({
          id,
          name,
          gender: f.gender.value,
          quote: "",
          images: [null],
        }),
      )
    )
      studentDetail(id);
  };
}
function studentDetail(id) {
  const s = state.students.find((s) => s.id === id);
  if (!s) return;
  modal(
    s.name,
    /* HTML */ `
      <div class="detail-photos">
        ${s.images
          .slice(0, 1)
          .map(
            (im, i) => /* HTML */ `
              <div>
                <div class="detail-photo">
                  ${media(im, `${s.name} · photo ${i + 1}`)}
                </div>
                ${mediaTools(`student:${id}:${i}`, im)}
              </div>
            `,
          )
          .join("")}
      </div>
      ${admin()
        ? /* HTML */ `
            <form id="quote-form">
              <label class="field">
                Their words
                <textarea
                  name="quote"
                  maxlength="300"
                  placeholder="A quote to remember…"
                >
${esc(s.quote)}</textarea
                >
              </label>
              <button class="pill">Save quote</button>
            </form>
            <div class="danger-zone">
              <button class="danger-button" data-delete-student="${id}">
                Delete student
              </button>
            </div>
          `
        : /* HTML */ `
            <blockquote class="student-quote-detail">
              ${esc(s.quote || "A story waiting to be told.")}
            </blockquote>
          `}
    `,
  );
  if (admin())
    $("#quote-form").onsubmit = async (e) => {
      e.preventDefault();
      if (!guard()) return;
      const value = e.target.quote.value.trim();
      if (
        await commit(
          () => (state.students.find((s) => s.id === id).quote = value),
        )
      )
        toast("Quote saved.");
    };
}
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function studentById(id) {
  return state.students.find((student) => student.id === id) || null;
}

function studentOptions(selectedId = "") {
  return [...state.students]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(
      (student) =>
        `<option value="${esc(student.id)}" ${student.id === selectedId ? "selected" : ""}>${esc(student.name)}</option>`,
    )
    .join("");
}

function officerHierarchyLevel(position = "") {
  const value = String(position).toLowerCase();
  if (/president|chairperson|chairman|class president/.test(value) && !/vice/.test(value)) return 0;
  if (/vice|deputy/.test(value)) return 1;
  return 2;
}

function officerPositionOrder(position = "") {
  const value = String(position).toLowerCase();
  const order = [
    /president|chairperson|chairman/,
    /vice|deputy/,
    /secretary/,
    /treasurer/,
    /auditor/,
    /p\.?\s*i\.?\s*o\.?|public information/,
    /business manager/,
    /peace officer|sergeant|marshal/,
  ];
  const index = order.findIndex((pattern) => pattern.test(value));
  return index === -1 ? 50 : index;
}

function officerCardHTML(officer, student, level) {
  return /* HTML */ `
    <article class="officer-card officer-level-${level}">
      <button
        class="officer-person"
        data-officer-detail="${esc(officer.id)}"
        aria-label="View ${esc(student.name)}, ${esc(officer.position || "Class Officer")}" 
      >
        <div class="officer-photo">${media(student.images?.[0], student.name)}</div>
        <div class="officer-copy">
          <h3>${esc(student.name)}</h3>
          <p class="officer-role">${esc(officer.position || "Class Officer")}</p>
        </div>
      </button>
      ${
        admin()
          ? `<div class="officer-admin admin-tools">
               <button data-edit-officer="${esc(officer.id)}">Edit</button>
               <button data-delete-officer="${esc(officer.id)}">Remove</button>
             </div>`
          : ""
      }
    </article>
  `;
}

function adviserOfficerCardHTML() {
  const adviser = state.adviser || {};
  return /* HTML */ `
    <article class="officer-card officer-card-adviser">
      <button
        class="officer-person"
        data-officer-adviser-detail="1"
        aria-label="View ${esc(adviser.name || "Cobalt Adviser")}, Class Adviser"
      >
        <div class="officer-photo">${media(adviser.image, adviser.name || "Cobalt Adviser")}</div>
        <div class="officer-copy">
          <h3>${esc(adviser.name || "Our Adviser")}</h3>
          <p class="officer-role">Class Adviser</p>
        </div>
      </button>
    </article>
  `;
}

function renderOfficers() {
  const officers = (state.officers || [])
    .map((officer) => ({
      officer,
      student: studentById(officer.studentId),
      level: officerHierarchyLevel(officer.position),
    }))
    .filter(({ student }) => student)
    .sort(
      (a, b) =>
        a.level - b.level ||
        officerPositionOrder(a.officer.position) - officerPositionOrder(b.officer.position) ||
        a.student.name.localeCompare(b.student.name),
    );

  const presidents = officers.filter((entry) => entry.level === 0);
  const rest = officers.filter((entry) => entry.level !== 0);

  $("#officer-grid").innerHTML = /* HTML */ `
    <div class="officer-roster">
      <div class="officer-roster-title" aria-hidden="true">
        <span>GRADE 9 · COBALT</span>
        <strong>CLASS OFFICERS</strong>
        <em>SY 2026–2027</em>
      </div>

      <div class="officer-roster-adviser">
        ${adviserOfficerCardHTML()}
      </div>

      ${
        presidents.length
          ? `<div class="officer-roster-president">
               ${presidents.map(({ officer, student }) => officerCardHTML(officer, student, 0)).join("")}
             </div>`
          : admin()
            ? `<div class="officer-roster-empty">Assign a Class President to complete the leadership roster.</div>`
            : ""
      }

      ${
        rest.length
          ? `<div class="officer-roster-team">
               ${rest.map(({ officer, student, level }) => officerCardHTML(officer, student, level)).join("")}
             </div>`
          : !officers.length
            ? `<div class="empty officer-empty">Class officers will appear here once your adviser assigns them.</div>`
            : ""
      }
    </div>
  `;
}

function officerDetail(id) {
  const officer = (state.officers || []).find((item) => item.id === id);
  if (!officer) return;
  const student = studentById(officer.studentId);
  if (!student) return;
  modal(
    "",
    /* HTML */ `
      <div class="mini-profile officer-profile-detail">
        <div class="mini-profile-photo">${media(student.images?.[0], student.name)}</div>
        <h3>${esc(student.name)}</h3>
        <p>${esc(officer.position || "Class Officer")}</p>
      </div>
    `,
  );
  $("#modal").classList.add("mini-profile-modal");
}

function officerAdviserDetail() {
  const adviser = state.adviser || {};
  modal(
    "",
    /* HTML */ `
      <div class="mini-profile officer-profile-detail">
        <div class="mini-profile-photo">${media(adviser.image, adviser.name || "Cobalt Adviser")}</div>
        <h3>${esc(adviser.name || "Our Adviser")}</h3>
        <p>Class Adviser</p>
      </div>
    `,
  );
  $("#modal").classList.add("mini-profile-modal");
}

function officerForm(officer = null) {
  if (!guard()) return;
  if (!state.students.length) return toast("Add students before assigning class officers.");
  modal(
    officer ? "Edit class officer" : "Assign a class officer",
    /* HTML */ `
      <form id="officer-form">
        <label class="field">
          classmate
          <select name="studentId" required>
            <option value="">Choose a student…</option>
            ${studentOptions(officer?.studentId || "")}
          </select>
        </label>
        <label class="field">
          Position
          <input
            name="position"
            maxlength="70"
            required
            placeholder="President, Vice President, Secretary…"
            value="${esc(officer?.position || "")}"
          />
        </label>
        <p class="hint">The officer card automatically uses the classmate’s existing profile photo.</p>
        <button class="pill">${officer ? "Save officer" : "Add officer"}</button>
      </form>
    `,
  );
  $("#officer-form").onsubmit = async (event) => {
    event.preventDefault();
    if (!guard()) return;
    const studentId = event.target.studentId.value;
    const position = event.target.position.value.trim();
    if (!studentId || !position) return toast("Choose a classmate and enter a position.");
    const ok = await commit(() => {
      state.officers ??= [];
      if (officer) {
        const current = state.officers.find((item) => item.id === officer.id);
        if (current) {
          current.studentId = studentId;
          current.position = position;
        }
      } else {
        state.officers.push({ id: uid(), studentId, position });
      }
    });
    if (ok) {
      close();
      toast(officer ? "Officer updated." : "Officer added.");
    }
  };
}

function deleteOfficer(id) {
  if (!guard()) return;
  const officer = (state.officers || []).find((item) => item.id === id);
  if (!officer) return;
  const student = studentById(officer.studentId);
  confirmRemoval(
    "Remove this officer?",
    `Remove ${student?.name || "this student"} from the class officers panel? Their classmate profile will stay in the class directory.`,
    async () => {
      if (await commit(() => (state.officers = (state.officers || []).filter((item) => item.id !== id)))) {
        close();
        toast("Officer removed.");
      }
    },
  );
}

function birthdayDistance(entry, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let target = new Date(now.getFullYear(), Number(entry.month) - 1, Number(entry.day));
  if (target < today) target = new Date(now.getFullYear() + 1, Number(entry.month) - 1, Number(entry.day));
  return Math.round((target - today) / 86400000);
}

function birthdayLabel(days) {
  if (days === 0) return "Today! ♡";
  if (days === 1) return "Tomorrow";
  return `In ${days} days`;
}

function validBirthdayDay(month, day) {
  const m = Number(month), d = Number(day);
  if (!Number.isInteger(m) || !Number.isInteger(d) || m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(2024, m, 0).getDate();
}

function birthdayEntries() {
  return (state.birthdays || [])
    .map((birthday) => ({
      birthday,
      student: studentById(birthday.studentId),
      days: birthdayDistance(birthday),
    }))
    .filter(({ student }) => student)
    .sort((a, b) => a.days - b.days || a.student.name.localeCompare(b.student.name));
}

function currentMonthBirthdayEntries(now = new Date()) {
  const month = now.getMonth() + 1;
  return birthdayEntries()
    .filter(({ birthday }) => Number(birthday.month) === month)
    .sort((a, b) => Number(a.birthday.day) - Number(b.birthday.day) || a.student.name.localeCompare(b.student.name));
}

function birthdayDetail(id) {
  const birthday = (state.birthdays || []).find((item) => item.id === id);
  if (!birthday) return;
  const student = studentById(birthday.studentId);
  if (!student) return;
  const monthName = MONTHS[Number(birthday.month) - 1] || "Birthday";
  modal(
    "",
    /* HTML */ `
      <div class="mini-profile birthday-profile-detail">
        <div class="mini-profile-photo">${media(student.images?.[0], student.name)}</div>
        <h3>${esc(student.name)}</h3>
        <p>${esc(monthName)} ${String(birthday.day).padStart(2, "0")}</p>
        ${
          admin()
            ? `<div class="birthday-detail-admin">
                 <button class="outline" data-edit-birthday="${esc(birthday.id)}">Edit birthday</button>
                 <button class="outline danger-lite" data-delete-birthday="${esc(birthday.id)}">Remove</button>
               </div>`
            : ""
        }
      </div>
    `,
  );
  $("#modal").classList.add("mini-profile-modal");
}

function renderBirthdays() {
  const now = new Date();
  const todayDay = now.getDate();
  const entries = currentMonthBirthdayEntries(now).sort((a, b) => {
    const aToday = Number(a.birthday.day) === todayDay ? 0 : 1;
    const bToday = Number(b.birthday.day) === todayDay ? 0 : 1;
    return aToday - bToday || Number(a.birthday.day) - Number(b.birthday.day);
  });
  const todays = entries.filter(({ birthday }) => Number(birthday.day) === todayDay);
  const monthName = MONTHS[now.getMonth()];
  const intro = $("#birthday-panel-intro");
  if (intro) {
    intro.textContent = todays.length
      ? `Today is extra special — Cobalt is celebrating ${todays.length === 1 ? todays[0].student.name : `${todays.length} classmates`}! Tap the birthday spotlight to celebrate with them.`
      : entries.length
        ? `${monthName} has ${entries.length === 1 ? "one Cobalt birthday" : `${entries.length} Cobalt birthdays`} worth remembering — tap a card for their spotlight.`
        : `No ${monthName} birthdays are saved yet. The full birthday calendar is still available anytime.`;
  }

  $("#birthday-grid").innerHTML = entries.length
    ? entries
        .map(
          ({ birthday, student }) => {
            const isToday = Number(birthday.day) === todayDay;
            return /* HTML */ `
              <article class="birthday-card ${isToday ? "birthday-today birthday-feature" : ""}">
                ${isToday ? "<div class='birthday-celebration-badge'>TODAY’S CELEBRATION ✦</div>" : ""}
                <button
                  class="birthday-person"
                  data-birthday-detail="${esc(birthday.id)}"
                  aria-label="View ${esc(student.name)}'s birthday"
                >
                  <div class="birthday-date-block">
                    <span>${esc(monthName.slice(0, 3).toUpperCase())}</span>
                    <strong>${String(birthday.day).padStart(2, "0")}</strong>
                  </div>
                  <div class="birthday-avatar">${media(student.images?.[0], student.name)}</div>
                  <div class="birthday-card-copy">
                    ${isToday ? '<span class="birthday-mini-kicker">HAPPY BIRTHDAY</span>' : ""}
                    <h3>${esc(student.name)}</h3>
                    <p>${isToday ? "Cobalt is celebrating you today ♡" : `${monthName} birthday`}</p>
                  </div>
                </button>
                ${
                  admin()
                    ? `<div class="birthday-admin admin-tools">
                         <button data-edit-birthday="${esc(birthday.id)}">Edit</button>
                         <button data-delete-birthday="${esc(birthday.id)}">Remove</button>
                       </div>`
                    : ""
                }
              </article>
            `;
          },
        )
        .join("")
    : `<div class="empty birthday-empty">No ${esc(monthName)} birthdays yet.</div>`;
}

function renderOpeningBirthday() {
  const holder = $("#opening-birthday");
  if (!holder) return;
  const now = new Date();
  const todays = birthdayEntries().filter(
    ({ birthday }) => Number(birthday.month) === now.getMonth() + 1 && Number(birthday.day) === now.getDate(),
  );
  if (!todays.length) {
    holder.hidden = true;
    holder.innerHTML = "";
    return;
  }
  holder.hidden = false;
  holder.innerHTML = /* HTML */ `
    <div class="opening-birthday-card">
      <p class="opening-birthday-kicker">TODAY, COBALT CELEBRATES</p>
      <div class="opening-birthday-people">
        ${todays
          .map(
            ({ birthday, student }) => /* HTML */ `
              <div class="opening-birthday-person">
                <div class="opening-birthday-photo">${media(student.images?.[0], student.name)}</div>
                <div class="opening-birthday-copy">
                  <strong class="opening-birthday-greeting">Happy Birthday!</strong>
                  <b class="opening-birthday-name">${esc(student.name)}</b>
                  <span>${esc(MONTHS[Number(birthday.month) - 1])} ${String(birthday.day).padStart(2, "0")}</span>
                </div>
              </div>
            `,
          )
          .join("")}
      </div>
    </div>
  `;
}

function birthdayForm(birthday = null) {
  if (!guard()) return;
  if (!state.students.length) return toast("Add students before adding birthdays.");
  const month = Number(birthday?.month || new Date().getMonth() + 1);
  modal(
    birthday ? "Edit birthday" : "Add a Cobalt birthday",
    /* HTML */ `
      <form id="birthday-form">
        <label class="field">
          classmate
          <select name="studentId" required>
            <option value="">Choose a student…</option>
            ${studentOptions(birthday?.studentId || "")}
          </select>
        </label>
        <div class="birthday-form-row">
          <label class="field">
            Month
            <select name="month" required>
              ${MONTHS.map((name, index) => `<option value="${index + 1}" ${index + 1 === month ? "selected" : ""}>${name}</option>`).join("")}
            </select>
          </label>
          <label class="field">
            Day
            <input name="day" type="number" min="1" max="31" required value="${esc(birthday?.day || "")}" placeholder="15" />
          </label>
        </div>
        <p class="hint">Only the month and day are saved — no birth year or age is stored.</p>
        <button class="pill">${birthday ? "Save birthday" : "Add birthday"}</button>
      </form>
    `,
  );
  $("#birthday-form").onsubmit = async (event) => {
    event.preventDefault();
    if (!guard()) return;
    const studentId = event.target.studentId.value;
    const monthValue = Number(event.target.month.value);
    const dayValue = Number(event.target.day.value);
    if (!studentId || !validBirthdayDay(monthValue, dayValue)) return toast("Please enter a valid birthday.");
    const duplicate = (state.birthdays || []).find(
      (item) => item.studentId === studentId && item.id !== birthday?.id,
    );
    if (duplicate) return toast("That classmate already has a birthday saved. Edit the existing one instead.");
    const ok = await commit(() => {
      state.birthdays ??= [];
      if (birthday) {
        const current = state.birthdays.find((item) => item.id === birthday.id);
        if (current) {
          current.studentId = studentId;
          current.month = monthValue;
          current.day = dayValue;
        }
      } else {
        state.birthdays.push({ id: uid(), studentId, month: monthValue, day: dayValue });
      }
    });
    if (ok) {
      close();
      toast(birthday ? "Birthday updated." : "Birthday added.");
    }
  };
}

function birthdayCalendarHTML() {
  const groups = new Map();
  for (const entry of birthdayEntries()) {
    const month = Number(entry.birthday.month);
    if (!groups.has(month)) groups.set(month, []);
    groups.get(month).push(entry);
  }
  if (!groups.size) return `<p class="hint">No birthdays have been added yet.</p>`;
  const manageHint = admin()
    ? `<p class="birthday-calendar-manage-hint">Admin mode · You can edit or remove birthdays from any month here.</p>`
    : "";
  return manageHint + [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(
      ([month, entries]) => /* HTML */ `
        <div class="birthday-month-group">
          <h3>${esc(MONTHS[month - 1])}</h3>
          <div class="birthday-calendar-list">
            ${entries
              .sort((a, b) => Number(a.birthday.day) - Number(b.birthday.day))
              .map(
                ({ birthday, student }) => /* HTML */ `
                  <div class="birthday-calendar-item">
                    <button data-birthday-detail="${esc(birthday.id)}" class="birthday-calendar-row">
                      <strong>${String(birthday.day).padStart(2, "0")}</strong>
                      <span>${esc(student.name)}</span>
                      <em>Birthday spotlight ↗</em>
                    </button>
                    ${
                      admin()
                        ? `<div class="birthday-calendar-actions">
                             <button class="outline" data-edit-birthday="${esc(birthday.id)}">Edit</button>
                             <button class="outline danger-lite" data-delete-birthday="${esc(birthday.id)}">Remove</button>
                           </div>`
                        : ""
                    }
                  </div>
                `,
              )
              .join("")}
          </div>
        </div>
      `,
    )
    .join("");
}

function deleteBirthday(id) {
  if (!guard()) return;
  const birthday = (state.birthdays || []).find((item) => item.id === id);
  if (!birthday) return;
  const student = studentById(birthday.studentId);
  confirmRemoval(
    "Remove this birthday?",
    `Remove ${student?.name || "this student"} from the birthday calendar? Their classmate profile will stay in the class directory.`,
    async () => {
      if (await commit(() => (state.birthdays = (state.birthdays || []).filter((item) => item.id !== id)))) {
        close();
        toast("Birthday removed.");
      }
    },
  );
}


const messageCount = () => (innerWidth <= 760 ? 1 : 3);
const albumCount = () =>
  innerWidth <= 350 ? 1 : innerWidth <= 480 ? 2 : innerWidth <= 760 ? 3 : 4;
function note(m, full = false) {
  const color = /^#[0-9a-f]{6}$/i.test(m.color) ? m.color : "#d6eaff";
  const rgb = color
    .slice(1)
    .match(/../g)
    .map((v) => parseInt(v, 16));
  const ink =
    rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114 > 145
      ? "#15382a"
      : "#ffffff";
  return /* HTML */ `
    <article
      class="note ${full ? "note-full" : ""}"
      style="background:${color};color:${ink}"
    >
      ${!full
        ? /* HTML */ `
            <button
              class="note-open"
              data-message="${m.id}"
              aria-label="Read message by ${esc(m.name)}"
            ></button>
          `
        : ""}
      <div class="note-body ${m.image ? "note-with-image" : ""}">
        <p>${esc(m.text)}</p>
        ${imageSource(m.image)
          ? /* HTML */ `
              <div class="note-image-frame">
                <img
                  class="note-image"
                  src="${esc(imageSource(m.image))}"
                  alt="Photo from ${esc(m.name)}"
                  loading="lazy"
                />
              </div>
            `
          : ""}
      </div>
      <div class="author">
        <strong>— ${esc(m.name)}</strong>
        <span>${esc(m.date)}</span>
      </div>
      ${admin()
        ? /* HTML */ `
            <div class="admin-tools">
              <button data-delete-message="${m.id}">Delete message</button>
            </div>
            ${mediaTools(`message:${m.id}`, m.image, false)}
          `
        : ""}
    </article>
  `;
}
function renderMessages() {
  const n = messageCount(),
    pages = Math.max(1, Math.ceil(state.messages.length / n));
  messagePage = Math.min(messagePage, pages - 1);
  $("#message-cards").innerHTML = state.messages.length
    ? state.messages
        .slice(messagePage * n, messagePage * n + n)
        .map((m) => note(m))
        .join("")
    : '<div class="empty">The noticeboard is waiting for your first little note.</div>';
  $("#message-dots").innerHTML = Array.from(
    { length: pages },
    (_, i) => /* HTML */ `
      <button
        class="${i === messagePage ? "selected" : ""}"
        data-message-page="${i}"
        aria-label="Message page ${i + 1}"
        aria-current="${i === messagePage}"
      ></button>
    `,
  ).join("");
  $('[data-action="messages-prev"]').disabled = messagePage === 0;
  $('[data-action="messages-next"]').disabled = messagePage >= pages - 1;
}
function messageDetail(id) {
  const m = state.messages.find((m) => m.id === id);
  if (m) modal("A note for Cobalt", note(m, true));
}
$("#message-image").onchange = () =>
  ($("#attachment-note").textContent =
    $("#message-image").files[0]?.name || "");
$("#message-form").onsubmit = async (e) => {
  e.preventDefault();
  if (!user) return login();
  const text = $("#message-text").value.trim();
  if (!text) return toast("Write a little message first.");
  const button = e.target.querySelector("[type=submit]");
  button.disabled = true;
  try {
    const image = $("#message-image").files[0]
      ? await readImage($("#message-image").files[0])
      : null;
    const ok = await postClassMessage({
      id:
        e.target.dataset.requestId ||
        (e.target.dataset.requestId = crypto.randomUUID()),
      text,
      color: $("#message-color").value,
      image,
    });
    if (ok) {
      delete e.target.dataset.requestId;
      messagePage = 0;
      renderMessages();
      e.target.reset();
      $("#attachment-note").textContent = "";
      $("#message-counter").textContent = "0 / 1000";
      updateComposerColor();
      toast("Your note is on the board.");
    }
  } catch (e) {
    toast(e.message);
  } finally {
    button.disabled = false;
  }
};
function renderAlbums() {
  const n = albumCount(),
    pages = Math.max(1, Math.ceil(state.albums.length / n));
  albumPage = Math.min(albumPage, pages - 1);
  $("#albums").innerHTML = state.albums.length
    ? state.albums
        .slice(albumPage * n, albumPage * n + n)
        .map(
          (a) => /* HTML */ `
            <button class="album-card" data-album="${a.id}">
              <div class="album-cover">
                ${media(a.images[0], "Memories go here")}
              </div>
              <h3>${esc(a.name)}</h3>
              <p>
                ${a.images.length}
                ${a.images.length === 1 ? "memory" : "memories"} · OPEN ALBUM ↗
              </p>
            </button>
          `,
        )
        .join("")
    : '<div class="empty">Every album starts with a moment.<br><br>Your adviser can create the first one.</div>';
  $("#album-page").textContent = `${albumPage + 1} / ${pages}`;
  $('[data-action="albums-prev"]').disabled = albumPage === 0;
  $('[data-action="albums-next"]').disabled = albumPage >= pages - 1;
}
function addAlbum() {
  if (!guard()) return;
  modal(
    "Save a chapter",
    /* HTML */ `
      <form id="album-form">
        <label class="field">
          Album name
          <input
            name="albumName"
            required
            maxlength="80"
            placeholder="Our first day together"
          />
        </label>
        <button class="pill">Create album</button>
      </form>
    `,
  );
  $("#album-form").onsubmit = async (e) => {
    e.preventDefault();
    if (!guard()) return;
    const name = e.target.albumName.value.trim();
    if (!name) return toast("Please enter an album name.");
    const id = uid();
    if (await commit(() => state.albums.push({ id, name, images: [] })))
      albumDetail(id);
  };
}
function albumDetail(id) {
  const a = state.albums.find((a) => a.id === id);
  if (!a) return;
  modal(
    a.name,
    `${
      admin()
        ? /* HTML */ `
            <div class="album-actions">
              <button class="pill" id="album-upload">+ Add photos</button>
              <button class="danger-button" data-delete-album="${id}">
                Delete album
              </button>
            </div>
            <p class="hint">Select one or more favorite moments.</p>
          `
        : ""
    }<div class="gallery">${
      a.images.length
        ? a.images
            .map(
              (im) => /* HTML */ `
                <div>
                  <button
                    type="button"
                    class="gallery-image"
                    data-album-photo="${im.id}"
                    data-photo-album="${a.id}"
                    aria-label="View full photo in ${esc(a.name)}"
                  >
                    ${media(im, a.name)}
                  </button>
                  ${mediaTools(`album:${id}:${im.id}`, im)}
                </div>
              `,
            )
            .join("")
        : '<div class="empty">The next memory belongs here.</div>'
    }</div>`,
  );
  if (admin())
    $("#album-upload").onclick = () => {
      if (guard())
        pickImage(async (images) => {
          if (!guard()) return;
          if (
            await commit(() =>
              state.albums
                .find((a) => a.id === id)
                .images.push(...images.map((im) => ({ ...im, id: uid() }))),
            )
          )
            albumDetail(id);
        }, true);
    };
}
const encouragements = [
  "You do not have to figure everything out today.",
  "A difficult day does not erase how far you have come.",
  "You belong here, even on the days you feel out of place.",
  "Rest is part of growing. You are allowed to pause.",
  "One small step is still a step forward.",
  "Your grades are a part of your story, not your whole identity.",
  "You can be proud of yourself for trying.",
  "It is okay to ask someone to sit with you for a while.",
  "You have time to become the person you want to be.",
  "Today can be messy and still contain a good moment.",
  "You are allowed to start again without having everything sorted.",
  "Learning something slowly is still learning.",
  "Your kindness matters more than you might realize.",
  "Take a breath. You only need to do the next little thing.",
  "You do not need to earn a place in this classroom.",
  "Not knowing yet is where learning begins.",
  "You can feel disappointed and still be worthy of care.",
  "Some progress is too quiet to notice right away.",
  "Asking for help is a skill worth practicing.",
  "Let yourself enjoy one simple thing today.",
  "You do not have to match anyone else’s pace.",
  "One mistake is not the ending of your story.",
  "Your voice deserves space, even if it shakes.",
  "You can set down something that is too heavy for today.",
  "There is more to you than your hardest moment.",
  "You are allowed to change your mind as you learn.",
  "Being a beginner takes courage.",
  "A kind word to yourself counts, too.",
  "You can care deeply and still need a break.",
  "Your effort has value even before the results arrive.",
  "Today’s goal can simply be getting through today.",
  "You are not behind in becoming yourself.",
  "Let the next breath be a fresh beginning.",
  "You can be both a work in progress and someone worth celebrating.",
  "It is okay if your best looks different today.",
  "You deserve friends who make room for the real you.",
  "You can take a hard task one question at a time.",
  "Your curiosity is worth keeping.",
  "You do not have to hide every feeling behind a smile.",
  "Small joys are still real joys.",
  "Give yourself the patience you would give a friend.",
  "You can try a different way without calling the first try a failure.",
  "A quiet contribution can make a big difference.",
  "You have permission to say that you need support.",
  "Your future has room for possibilities you have not met yet.",
  "You are more than a comparison with someone else.",
  "An unfinished task can wait while you take care of yourself.",
  "You do not have to be perfect to make a good memory.",
  "Sometimes courage looks like showing up quietly.",
  "Notice one thing you did today that took effort.",
  "Your feelings do not need to be the same as everyone else’s.",
  "You can miss an opportunity and still find another direction.",
  "You deserve a gentle conversation with yourself.",
  "You do not have to turn every moment into an achievement.",
  "Being thoughtful is a strength.",
  "You can celebrate a small win without explaining it.",
  "The next page does not have to look like this one.",
  "You can learn from yesterday without living there.",
  "Let yourself be supported by people you trust.",
  "You bring something to this class that no one else can bring.",
  "A pause can help you see the next step more clearly.",
  "You are allowed to find some things difficult.",
  "It is never silly to care about something that matters to you.",
  "You can ask for an explanation one more time.",
  "Your dreams are allowed to grow and change.",
  "You are worth listening to.",
  "You can be kind without saying yes to everything.",
  "You do not need a big reason to take a calming breath.",
  "Trying again can begin with something very small.",
  "There is room for your questions here.",
  "Your worth does not disappear when you need help.",
  "You can do something brave while feeling nervous.",
  "Take a moment to unclench your shoulders.",
  "You can choose one manageable thing and let that be enough for now.",
  "You deserve encouragement on ordinary days, too.",
  "It is okay to feel proud of progress that others cannot see.",
  "A tough lesson can be approached with a fresh start tomorrow.",
  "Your gentleness is not a weakness.",
  "You are allowed to have interests that make you different.",
  "You can make room for hope without forcing yourself to feel happy.",
  "The care you give others is care you deserve as well.",
  "Your presence matters beyond what you produce.",
  "You can spend a moment outside your worries.",
  "Learning to rest is something you can practice.",
  "You do not have to have the right words to reach out.",
  "You can make today a little softer for yourself.",
  "You are not a problem to be solved.",
  "There is value in the things you notice and wonder about.",
  "You can leave room for an unexpected good moment.",
  "You are allowed to be proud and nervous at the same time.",
  "You can take feedback without turning it into a judgment of your worth.",
  "A favorite song or a quiet minute can be a small comfort.",
  "You can return to a goal after taking a break.",
  "You deserve respect while you are still learning.",
  "You can let someone know that today has been hard.",
  "Your path can have bends and still be your own.",
  "You can choose patience over pressure for the next few minutes.",
  "You do not need to solve tomorrow before going to sleep tonight.",
  "You are part of our class, on your bright days and your cloudy ones.",
  "For this moment, let being yourself be enough.",
];
function nextEncouragement() {
  let index;
  const success = (() => {
    if (!state.deck.length) {
      state.deck = encouragements.map((_, i) => i);
      for (let i = state.deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [state.deck[i], state.deck[j]] = [state.deck[j], state.deck[i]];
      }
      if (state.deck.at(-1) === state.last)
        [state.deck[0], state.deck[state.deck.length - 1]] = [
          state.deck.at(-1),
          state.deck[0],
        ];
    }
    index = state.deck.pop();
    state.last = index;
    return true;
  })();
  if (!success) return null;
  const text = encouragements[index];
  modal(
    "A little sunshine for you",
    /* HTML */ `
      <div class="encouragement">
        <span>☀</span>
        <p>${esc(text)}</p>
        <button class="pill" id="another-reminder">
          One more little reminder
        </button>
        <p class="hint" style="font:14px 'DM Sans',sans-serif">
          ${100 - state.deck.length} of 100 reminders in this round
        </p>
      </div>
    `,
  );
  $("#another-reminder").onclick = nextEncouragement;
  return { message: text, remaining: state.deck.length };
}
$("#encourage").onclick = nextEncouragement;
function showAllStudentsPopup() {
  modal(
    "Our classmates",
    /* HTML */ `<div class="all-students">${studentsHTML(true, "")}</div>`,
    { restore: showAllStudentsPopup },
  );
}

function showBirthdayCalendarPopup() {
  modal(
    "Cobalt birthday calendar",
    /* HTML */ `<div class="birthday-calendar">${birthdayCalendarHTML()}</div>`,
    { restore: showBirthdayCalendarPopup },
  );
}

function showAllMessagesPopup() {
  modal(
    "Our noticeboard",
    /* HTML */ `
      <div class="all-notes">
        ${
          state.messages.length
            ? state.messages.map((m) => note(m, true)).join("")
            : "<p>No notes yet. Yours can be the first.</p>"
        }
      </div>
    `,
    { restore: showAllMessagesPopup },
  );
}

const actions = {
  "all-students": showAllStudentsPopup,
  "add-student": addStudent,
  "add-officer": () => officerForm(),
  "add-birthday": () => birthdayForm(),
  "all-birthdays": showBirthdayCalendarPopup,
  "all-messages": showAllMessagesPopup,
  "messages-prev": () => {
    messagePage = Math.max(0, messagePage - 1);
    renderMessages();
  },
  "messages-next": () => {
    messagePage++;
    renderMessages();
  },
  "add-album": addAlbum,
  "albums-prev": () => {
    albumPage = Math.max(0, albumPage - 1);
    renderAlbums();
  },
  "albums-next": () => {
    albumPage++;
    renderAlbums();
  },
};

document.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  const d = b.dataset;

  if (d.addAchievement !== undefined) editAchievement();
  else if (d.editAchievement) editAchievement(d.editAchievement);
  else if (d.deleteAchievement) deleteAchievement(d.deleteAchievement);
  else if (d.achievement) achievementDetail(d.achievement);
  else if (d.achievementFilter !== undefined) {
    achievementCategory = d.achievementFilter;
    renderAchievements();
  } else if (d.noteColor) {
    $("#message-color").value = d.noteColor;
    updateComposerColor();
  } else if (d.action) actions[d.action]?.();
  else if (d.officerDetail) officerDetail(d.officerDetail);
  else if (d.officerAdviserDetail) officerAdviserDetail();
  else if (d.birthdayDetail) birthdayDetail(d.birthdayDetail);
  else if (d.student) studentDetail(d.student);
  else if (d.editOfficer)
    officerForm((state.officers || []).find((item) => item.id === d.editOfficer));
  else if (d.deleteOfficer) deleteOfficer(d.deleteOfficer);
  else if (d.editBirthday)
    birthdayForm((state.birthdays || []).find((item) => item.id === d.editBirthday));
  else if (d.deleteBirthday) deleteBirthday(d.deleteBirthday);
  else if (d.albumPhoto) albumPhotoDetail(d.photoAlbum, d.albumPhoto);
  else if (d.album) albumDetail(d.album);
  else if (d.message) messageDetail(d.message);
  else if (d.messagePage !== undefined) {
    messagePage = +d.messagePage;
    renderMessages();
  } else if (d.media) {
    if (guard())
      pickImage(async (image) => {
        if (guard() && (await commit(() => resolveMedia(d.media).set(image))))
          refreshDetail(d.media);
      });
  } else if (d.resize) cropImage(d.resize);
  else if (d.remove) {
    if (guard())
      confirmDelete(async () => {
        if (await commit(() => resolveMedia(d.remove).set(null)))
          refreshDetail(d.remove);
      });
  } else if (d.deleteStudent) {
    deleteStudent(d.deleteStudent);
  } else if (d.deleteAlbum) {
    deleteAlbum(d.deleteAlbum);
  } else if (d.deleteMessage) {
    if (guard())
      confirmDelete(async () => {
        if (
          await commit(
            () =>
              (state.messages = state.messages.filter(
                (m) => m.id !== d.deleteMessage,
              )),
          )
        )
          close();
      });
  }
});
function render() {
  account();
  renderHero();
  renderStudents();
  renderOfficers();
  renderBirthdays();
  renderOpeningBirthday();
  renderMessages();
  renderAlbums();
  renderAchievements();
}
let achievementCategory = "";
function renderAchievements() {
  const items = state.achievements || [];
  // Categories come from the adviser's saved achievements, never a preset list.
  const achievementCategories = [
    "",
    ...new Set(
      items.map((item) => String(item.category || "").trim()).filter(Boolean),
    ),
  ];
  if (!achievementCategories.includes(achievementCategory))
    achievementCategory = "";
  $("#achievement-count").textContent = items.length;
  $("#achievement-admin").innerHTML = admin()
    ? '<button class="pill" data-add-achievement>+ Add achievement</button>'
    : "";
  $("#achievement-filters").innerHTML = achievementCategories
    .map(
      (category) =>
        `<button data-achievement-filter="${esc(category)}" aria-pressed="${category === achievementCategory}">${esc(category || "All achievements")}</button>`,
    )
    .join("");
  const visible = items
    .filter(
      (item) =>
        achievementCategory === "" ||
        String(item.category || "").trim() === achievementCategory,
    )
    .sort(
      (a, b) =>
        Number(b.featured) - Number(a.featured) ||
        String(b.date).localeCompare(String(a.date)),
    );
  $("#achievement-grid").innerHTML = visible.length
    ? visible
        .map(
          (item) => `
    <article class="achievement-card ${item.featured ? "is-featured" : ""}">
      <button class="achievement-open" data-achievement="${esc(item.id)}">
        <div class="achievement-photo">${item.image ? media(item.image, item.title) : '<span class="achievement-emblem" aria-hidden="true">★</span>'}</div>
        <span class="achievement-category">${esc(item.category)}${item.featured ? " · SPOTLIGHT" : ""}</span>
        <h3>${esc(item.title)}</h3><p>${esc(item.recipients || "The Cobalt crew")}</p>
        <time datetime="${esc(item.date)}">${esc(item.date)}</time>
        <span class="achievement-read">Read our story ↗</span>
      </button>
      ${admin() ? `<div class="achievement-controls"><button class="outline" data-edit-achievement="${esc(item.id)}">Edit</button><button class="outline" data-delete-achievement="${esc(item.id)}">Delete</button></div>` : ""}
    </article>`,
        )
        .join("")
    : `<div class="achievement-empty"><span aria-hidden="true">✦</span><h3>${items.length ? "The next win belongs here." : "Our victory pages are ready."}</h3><p>${admin() ? "Add a class milestone, competition result, or an act of kindness worth remembering." : "Come back for class milestones, awards, and moments that make us proud."}</p></div>`;
}
function achievementDetail(id) {
  const item = (state.achievements || []).find((value) => value.id === id);
  if (!item) return;
  modal(
    item.title,
    `<div class="achievement-detail">
    ${item.image ? `<div class="detail-photo">${media(item.image, item.title)}</div>` : '<div class="achievement-emblem">★</div>'}
    <p class="eyebrow">${esc(item.category)} · ${esc(item.date)}</p>
    <h3>${esc(item.recipients || "The Cobalt crew")}</h3>
    <p class="achievement-story">${esc(item.description)}</p>
    ${admin() ? `<div class="actions"><button class="pill" data-edit-achievement="${esc(id)}">Edit achievement</button><button class="outline" data-delete-achievement="${esc(id)}">Delete achievement</button></div>${item.image ? mediaTools(`achievement:${id}`, item.image) : ""}` : ""}
  </div>`,
  );
}
function editAchievement(id = null) {
  if (!guard()) return;
  const item = (state.achievements || []).find((value) => value.id === id);
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  modal(
    item ? "Edit our victory page" : "A new win for Cobalt!",
    `<form id="achievement-form">
    <label class="field">Achievement title<input name="title" maxlength="120" required value="${esc(item?.title || "")}" placeholder="What are we celebrating?"></label>
    <div class="achievement-form-row"><label class="field">Category<input name="category" maxlength="60" required value="${esc(item?.category || "")}" placeholder="Enter your own category"></label>
    <label class="field">Date<input name="date" type="date" required value="${esc(item?.date || today)}"></label></div>
    <label class="field">Who are we celebrating?<input name="recipients" maxlength="180" value="${esc(item?.recipients || "")}" placeholder="A student, team, or our whole class"></label>
    <label class="field">The story<textarea name="description" maxlength="2000" rows="5" required>${esc(item?.description || "")}</textarea></label>
    <label class="field">${item?.image ? "Replace photo (optional)" : "Photo (optional)"}<input name="photo" type="file" accept="image/jpeg,image/png,image/webp"></label>
    <label class="achievement-check"><input name="featured" type="checkbox" ${item?.featured ? "checked" : ""}> Give this achievement a spotlight</label>
    <p id="achievement-error" class="auth-error" role="alert"></p><button class="pill" type="submit">Save achievement ↗</button>
  </form>`,
  );
  const form = $("#achievement-form");
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (!guard() || form.dataset.busy) return;
    const button = form.querySelector('[type="submit"]');
    form.dataset.busy = "true";
    button.disabled = true;
    button.textContent = "Saving…";
    try {
      const values = form.elements;
      const title = values.title.value.trim(),
        description = values.description.value.trim();
      if (!values.category.value.trim())
        throw new Error("Enter a category for this achievement.");
      if (!title || !description) throw new Error("Enter a title and a story.");
      const image = values.photo.files[0]
        ? await readImage(values.photo.files[0])
        : item?.image || null;
      const next = {
        id: id || uid(),
        title,
        description,
        image,
        category: values.category.value.trim(),
        date: values.date.value,
        recipients: values.recipients.value.trim(),
        featured: values.featured.checked,
      };
      if (
        await commit(() => {
          state.achievements ??= [];
          const index = state.achievements.findIndex(
            (value) => value.id === next.id,
          );
          if (index < 0) state.achievements.push(next);
          else state.achievements[index] = next;
        })
      ) {
        achievementDetail(next.id);
        toast("Achievement saved.");
      }
    } catch (error) {
      if (form.isConnected) $("#achievement-error").textContent = error.message;
    } finally {
      delete form.dataset.busy;
      button.disabled = false;
      button.textContent = "Save achievement ↗";
    }
  };
}
function deleteAchievement(id) {
  if (!guard()) return;
  const item = (state.achievements || []).find((value) => value.id === id);
  if (!item) return;
  confirmRemoval(
    "Delete this achievement?",
    `Remove “${item.title}” and its unused photo from the classroom?`,
    async () => {
      if (
        await commit(() => {
          state.achievements = state.achievements.filter(
            (value) => value.id !== id,
          );
        })
      ) {
        close();
        toast("Achievement deleted.");
      }
    },
  );
}

const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries)
      if (entry.isIntersecting) {
        $$("nav a").forEach((a) => {
          const active = a.hash === "#" + entry.target.id;
          a.classList.toggle("active", active);
          if (active) a.setAttribute("aria-current", "location");
          else a.removeAttribute("aria-current");
        });
      }
  },
  { rootMargin: "-30% 0px -50% 0px", threshold: 0 },
);
$$("main>section").forEach((s) => observer.observe(s));
window.addEventListener("resize", () => {
  renderMessages();
  renderAlbums();
});
if (document.modelContext?.registerTool) {
  try {
    Promise.resolve(
      document.modelContext.registerTool({
        name: "show_cobalt_encouragement",
        description:
          "Show the next non-repeating encouragement in the classroom dialog.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false },
        execute: (input) => {
          if (!input || typeof input !== "object" || Object.keys(input).length)
            throw Error("Expected an empty object.");
          return nextEncouragement();
        },
      }),
    ).catch(() => {});
  } catch {}
}
render();

// The same colors appear in the writing area and on the pinned note.
function updateComposerColor() {
  const color = $("#message-color").value;
  $("#message-form").style.setProperty("--chosen-note", color);
  $$(".swatches button").forEach((b) =>
    b.setAttribute("aria-pressed", String(b.dataset.noteColor === color)),
  );
}
$("#message-color").addEventListener("input", updateComposerColor);
$("#message-text").addEventListener(
  "input",
  () =>
    ($("#message-counter").textContent =
      `${$("#message-text").value.length} / 1000`),
);
updateComposerColor();
// A short, skippable opening; all controls remain accessible after dismissal.
const intro = $("#opening");

function dismissOpening() {
  intro.classList.add("dismissed");
  document.body.classList.remove("opening-active");
  for (const el of [$("#site-header"), $("main"), $(".section-rail")])
    el.inert = false;
  setTimeout(() => {
    intro.hidden = true;
  }, 650);
}
$("#skip-opening").addEventListener("click", () => {
  dismissOpening();
  $("header .brand").focus();
});
// Entry is always explicit, including when reduced motion is enabled.
document.body.classList.add("opening-active");
for (const el of [$("#site-header"), $("main"), $(".section-rail")])
  el.inert = true;
if (matchMedia("(prefers-reduced-motion: reduce)").matches)
  intro.classList.add("reduced-opening");
// Free scrolling: update navigation highlights without moving the page.
let scrollFrame = 0;
function updateSectionNavigation() {
  const headerHeight = $("#site-header").getBoundingClientRect().height;
  document.documentElement.style.setProperty(
    "--header-height",
    `${headerHeight}px`,
  );
  const center = headerHeight + (innerHeight - headerHeight) / 2;
  const panels = $$("main>section");
  const nearest = panels.reduce(
    (best, p) => {
      const r = p.getBoundingClientRect(),
        distance =
          center < r.top
            ? r.top - center
            : center > r.bottom
              ? center - r.bottom
              : 0;
      return distance < best.distance ? { id: p.id, distance } : best;
    },
    { id: "home", distance: Infinity },
  );
  $$("header nav a,.section-rail a").forEach((a) => {
    const active = a.hash === "#" + nearest.id;
    a.classList.toggle("active", active);
    if (active) a.setAttribute("aria-current", "location");
    else a.removeAttribute("aria-current");
  });
  scrollFrame = 0;
}
observer.disconnect();
addEventListener(
  "scroll",
  () => {
    if (!scrollFrame)
      scrollFrame = requestAnimationFrame(updateSectionNavigation);
  },
  { passive: true },
);
addEventListener("resize", updateSectionNavigation);
updateSectionNavigation();

$("#student-search").addEventListener("input", (e) => {
  studentQuery = e.target.value;
  renderStudents();
});
$("#clear-student-search").addEventListener("click", () => {
  studentQuery = "";
  $("#student-search").value = "";
  renderStudents();
  $("#student-search").focus();
});
$("#meet-adviser").addEventListener("click", adviserDetail);
function adviserDetail() {
  const a = state.adviser;
  modal(
    "Meet our adviser",
    /* HTML */ `
      <div class="adviser-profile">
        <div>
          <div class="adviser-photo">
            ${media(a.image, "Your adviser’s photo")}
          </div>
          ${mediaTools("adviser:main", a.image)}
        </div>
        <div class="adviser-copy">
          <p class="eyebrow">GRADE 9 · COBALT</p>
          <h3>${esc(a.name || "Your Cobalt adviser")}</h3>
          <p class="adviser-message">
            ${esc(a.message || "A message from your adviser will appear here.")}
          </p>
        </div>
      </div>
      ${admin()
        ? /* HTML */ `
            <form id="adviser-form">
              <label class="field">
                Your name
                <input
                  name="adviserName"
                  maxlength="100"
                  value="${esc(a.name)}"
                  placeholder="Enter your name"
                  required
                />
              </label>
              <label class="field">
                Your message to the class
                <textarea
                  name="adviserMessage"
                  maxlength="2000"
                  placeholder="Dear classmates, …"
                >
${esc(a.message)}</textarea
                >
              </label>
              <button class="pill">Save adviser profile</button>
            </form>
          `
        : ""}
    `,
  );
  if (admin())
    $("#adviser-form").onsubmit = async (e) => {
      e.preventDefault();
      if (!guard()) return;
      const name = e.target.adviserName.value.trim(),
        message = e.target.adviserMessage.value.trim();
      if (!name) return toast("Please enter your name.");
      if (
        await commit(() => {
          state.adviser.name = name;
          state.adviser.message = message;
        })
      ) {
        adviserDetail();
        toast("Adviser profile saved.");
      }
    };
}
async function changeSession(nextUser) {
  if (authBusy || cloudBusy || cloudLoading) return;
  authBusy = true;
  sessionVersion += 1;
  const signingIn = Boolean(nextUser);
  modal(
    signingIn ? "Signing you in…" : "Signing you out…",
    /* HTML */ `
      <div class="session-state" role="status">
        <div class="session-loader">
          <img src="assets/cobalt-mark.svg" alt="" width="52" height="52" />
        </div>
        <p>
          ${signingIn
            ? "Getting your classroom ready."
            : "Wrapping up your visit."}
        </p>
      </div>
    `,
  );
  $("#close-modal").disabled = true;
  try {
    if (!signingIn) await CobaltAuth.signOut();
    user = nextUser;
    state = emptyClassroom();
    cloudReady = false;
    photoUrls.clear();
    await loadClassroom();
    await refreshPhotoUrls();
    await new Promise((resolve) => setTimeout(resolve, 850));
  } catch (error) {
    authBusy = false;
    $("#close-modal").disabled = false;
    render();
    modal("Please try again", `<p>${esc(error.message)}</p>`);
    return;
  }
  authBusy = false;
  $("#close-modal").disabled = false;
  render();
  modal(
    signingIn ? "You’re signed in!" : "You’re signed out",
    /* HTML */ `
      <div class="session-state">
        <span class="session-check" aria-hidden="true">✓</span>
        <h3>
          ${signingIn
            ? `Welcome, ${esc(nextUser.name)}!`
            : "See you in the classroom!"}
        </h3>
        <p>
          ${signingIn
            ? "You’re ready to leave a little kindness."
            : "Your classroom content is saved in Supabase."}
        </p>
        <button class="pill" id="session-done">
          ${signingIn ? "Back to the classroom" : "Got it"}
        </button>
      </div>
    `,
  );
  $("#session-done").onclick = close;
}
// The database is the source of truth after the first admin import.

function confirmRemoval(title, description, onConfirm) {
  if (!guard()) return;
  modal(
    title,
    /* HTML */ `
      <p class="hint">${esc(description)}</p>
      <div class="actions">
        <button class="outline" id="keep-item">Keep it</button>
        <button class="danger-button" id="remove-item">
          Delete permanently
        </button>
      </div>
    `,
  );
  $("#keep-item").onclick = close;
  $("#remove-item").onclick = async () => {
    if (guard()) await onConfirm();
  };
}
function deleteStudent(id) {
  if (!guard()) return;
  const student = state.students.find((s) => s.id === id);
  if (!student) return;
  confirmRemoval(
    "Delete this student?",
    `Remove ${student.name}, their quote and profile photo from the shared classroom? This does not delete their sign-in account.`,
    async () => {
      if (
        await commit(() => {
          state.deletedStudents ??= [];
          state.deletedStudents.push({ id: student.id, name: student.name });
          state.students = state.students.filter((s) => s.id !== id);
        })
      ) {
        close();
        toast("Student deleted.");
      }
    },
  );
}
function deleteAlbum(id) {
  if (!guard()) return;
  const album = state.albums.find((a) => a.id === id);
  if (!album) return;
  confirmRemoval(
    "Delete this album?",
    `Remove “${album.name}” and all ${album.images.length} photos in it from the shared classroom?`,
    async () => {
      if (
        await commit(
          () => (state.albums = state.albums.filter((a) => a.id !== id)),
        )
      ) {
        close();
        toast("Album deleted.");
      }
    },
  );
}

function albumPhotoDetail(albumId, imageId) {
  const album = state.albums.find((a) => a.id === albumId);
  const photo = album?.images.find((image) => image.id === imageId);
  if (!photo) return;
  modal(
    album.name,
    /* HTML */ `
      <div class="album-photo-view">
        <img
          src="${esc(imageSource(photo))}"
          alt="${esc(album.name)} — full photo"
        />
      </div>
      <div class="photo-view-actions">
        <button class="outline" id="back-to-album">← Back to album</button>
      </div>
    `,
  );
  $("#modal").classList.add("image-viewer-modal");
  $("#back-to-album").onclick = () => albumDetail(albumId);
}

// Load the shared classroom for visitors and refresh it while the page is open.
void restoreCobaltSession();
setInterval(() => {
  if (!authBusy) void restoreCobaltSession();
}, 30 * 1000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && !authBusy) void restoreCobaltSession();
});
