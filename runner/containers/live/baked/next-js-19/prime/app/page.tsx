import Grid from '@/components/Grid';
import { data } from './data';

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col max-w-[1045px] p-4">
      <Grid data={data}></Grid>
    </main>
  );
}
