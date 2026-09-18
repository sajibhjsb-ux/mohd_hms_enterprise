import { SessionProvider } from "@/components/hms/session";
import { Gate } from "@/components/hms/gate";

export default function Page() {
  return (
    <SessionProvider>
      <Gate />
    </SessionProvider>
  );
}