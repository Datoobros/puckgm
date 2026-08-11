import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import {
  ClerkProvider,
  Show,
  SignInButton,
  SignUpButton,
  UserButton,
} from "@clerk/nextjs";
import { NavBar } from "@/components/NavBar";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "puckgm",
  description: "Dynasty fantasy hockey GM sim",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <ClerkProvider>
      <html
        lang="en"
        className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      >
        <body className="min-h-full flex flex-col">
          <header className="flex items-center gap-4 border-b border-zinc-800 bg-zinc-950 px-4 py-3 text-zinc-100">
            <Link href="/" className="text-sm font-bold tracking-tight text-white">
              puckgm
            </Link>
            <Show when="signed-in">
              <NavBar />
            </Show>
            <div className="ml-auto flex items-center gap-3">
              <Show when="signed-out">
                <SignInButton mode="modal">
                  <button className="text-sm text-zinc-300 hover:text-white">Sign in</button>
                </SignInButton>
                <SignUpButton mode="modal">
                  <button className="rounded bg-white px-3 py-1.5 text-sm font-medium text-zinc-950">
                    Sign up
                  </button>
                </SignUpButton>
              </Show>
              <Show when="signed-in">
                <UserButton />
              </Show>
            </div>
          </header>
          <main className="flex-1">{children}</main>
        </body>
      </html>
    </ClerkProvider>
  );
}
