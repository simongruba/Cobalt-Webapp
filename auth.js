"use strict";

window.CobaltAuth = (() => {
  // Clean up email addresses and usernames.
  function requireConnection() {
    if (!supabaseClient)
      throw new Error("Account services are not connected yet.");
  }
  function normalize(value) {
    return String(value ?? "")
      .trim()
      .toLowerCase();
  }

  // Read the signed-in user's role from Supabase.
  async function getAccountRole() {
    const { data, error } = await supabaseClient.rpc("cobalt_role");

    if (error) {
      console.error("Could not load account role:", error.message);

      throw new Error(
        "Could not load your account permissions. Please try again.",
      );
    }

    return data || "pending";
  }

  // Prepare the user information displayed on the website.
  function formatUser(user, role) {
    const username =
      user.user_metadata?.username ||
      user.user_metadata?.display_name ||
      user.email?.split("@")[0] ||
      "Cobaltite";

    return {
      id: user.id,
      email: user.email,
      username: username,
      name: username,
      role: role,
    };
  }

  // Create a new account.
  async function register({ email, username, password, confirmation }) {
    requireConnection();
    email = normalize(email);
    username = normalize(username);

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      throw new Error("Enter a valid email address.");
    }

    if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
      throw new Error(
        "Use 3–32 letters, numbers, dots, underscores or hyphens for your username.",
      );
    }

    if (
      typeof password !== "string" ||
      password.length < 8 ||
      password.length > 128
    ) {
      throw new Error("Use a password of 8–128 characters.");
    }

    if (password !== confirmation) {
      throw new Error("The passwords do not match.");
    }

    const { data, error } = await supabaseClient.auth.signUp({
      email: email,
      password: password,
      options: {
        data: {
          username: username,
          display_name: username,
        },
      },
    });

    if (error) {
      console.error("Cobalt sign-up failed:", error.message);

      throw new Error(error.message);
    }

    if (!data.user) {
      throw new Error("The account could not be created.");
    }

    // New accounts start as pending.
    // An account may still need email confirmation.
    return formatUser(data.user, "pending");
  }

  // Sign in to an existing account.
  async function signIn({ email, password }) {
    requireConnection();
    email = normalize(email);

    if (
      !email ||
      typeof password !== "string" ||
      !password ||
      password.length > 128
    ) {
      throw new Error("Enter your email and password.");
    }

    const { data, error } = await supabaseClient.auth.signInWithPassword({
      email: email,
      password: password,
    });

    if (error) {
      throw new Error(error.message);
    }

    if (!data.user) {
      throw new Error("Login failed.");
    }

    const role = await getAccountRole();

    return formatUser(data.user, role);
  }

  // Sign out.
  async function signOut() {
    const { error } = await supabaseClient.auth.signOut();

    if (error) {
      throw new Error(error.message);
    }
  }

  // Restore the signed-in user when the page loads.
  async function getCurrentUser() {
    if (!supabaseClient) return null;
    const { data, error } = await supabaseClient.auth.getUser();

    if (error || !data.user) {
      return null;
    }

    const role = await getAccountRole();

    return formatUser(data.user, role);
  }

  return Object.freeze({
    register,
    signIn,
    signOut,
    getCurrentUser,
  });
})();
