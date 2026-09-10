import type { Metadata } from "next";
import Link from "next/link";
import { Inter, Oswald } from "next/font/google";
import {
  ClerkProvider,
  Show,
  SignInButton,
  SignUpButton,
  UserButton,
} from "@clerk/nextjs";
import { NavBar } from "@/components/NavBar";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const oswald = Oswald({
  variable: "--font-oswald",
  weight: ["500", "600"],
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
        className={`${inter.variable} ${oswald.variable} h-full antialiased`}
      >
        <body className="min-h-full flex flex-col">
          <header className="flex items-center gap-4 border-b border-border bg-surface px-4 py-3">
            <Link href="/" className="font-heading text-base font-semibold tracking-tight text-navy">
              Puck<span className="text-gold">GM</span>
            </Link>
            <Show when="signed-in">
              <NavBar />
            </Show>
            <div className="ml-auto flex items-center gap-3">
              <Show when="signed-out">
                <SignInButton mode="modal">
                  <button className="text-sm text-muted hover:text-foreground">Sign in</button>
                </SignInButton>
                <SignUpButton mode="modal">
                  <button className="rounded-md bg-navy px-4 py-1.5 text-sm font-medium text-navy-foreground hover:opacity-90">
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
