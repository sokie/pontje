import { create } from "zustand"

import { api } from "@/api/client"
import type { components } from "@/api/schema"
import { closeSocket } from "@/lib/ws/socket"

type Me = components["schemas"]["MeOut"]

type SessionState = {
  status: "loading" | "anon" | "authed"
  me: Me | null
  fetchMe: () => Promise<void>
  devLogin: (email: string) => Promise<string | null>
  logout: () => Promise<void>
}

export const useSession = create<SessionState>((set) => ({
  status: "loading",
  me: null,

  fetchMe: async () => {
    const { data, response } = await api.GET("/api/v1/auth/me").catch(() => ({
      data: undefined,
      response: undefined,
    }))
    if (data) set({ status: "authed", me: data })
    else if (response?.status === 401) set({ status: "anon", me: null })
    else set({ status: "anon", me: null })
  },

  devLogin: async (email: string) => {
    const { error } = await api.POST("/api/v1/auth/dev-login", { body: { email } })
    if (error) return (error as { detail?: string }).detail ?? "login failed"
    await useSession.getState().fetchMe()
    return null
  },

  logout: async () => {
    await api.POST("/api/v1/auth/logout").catch(() => null)
    closeSocket()
    set({ status: "anon", me: null })
  },
}))
