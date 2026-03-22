import { createContext, useContext } from "react";
import type { StatusContextValue } from "../types";

const StatusContext = createContext<StatusContextValue>({
  text: "Ready",
  color: "text-blue-600",
  setStatus: () => {},
});

export const useStatus = () => useContext(StatusContext);

export { StatusContext };
