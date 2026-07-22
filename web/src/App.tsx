import { AppShell } from "@/components/AppShell";
import { Toaster } from "@/components/ui/sonner";
import { ConfirmProvider } from "@/components/ConfirmDialog";

export default function App() {
  return (
    <ConfirmProvider>
      <AppShell />
      <Toaster />
    </ConfirmProvider>
  );
}
