import { useEffect, useState } from "react";

// Seed: a component that loads data from an injected function, so tests can mock it.
export default function Greeting({ load }) {
  const [state, setState] = useState({ status: "loading" });
  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(load)
      .then((user) => live && setState(user && user.name ? { status: "ok", name: user.name } : { status: "error" }))
      .catch(() => live && setState({ status: "error" }));
    return () => { live = false; };
  }, [load]);
  if (state.status === "loading") return <p>Loading</p>;
  if (state.status === "error") return <p role="alert">Could not load</p>;
  return <p>Hello, {state.name}</p>;
}
