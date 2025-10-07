import Grid from '~/components/Grid';
import { data } from '../data';

export default function Index() {
  return (
    <div
      style={{
        fontFamily: 'system-ui, sans-serif',
        lineHeight: '1.8',
        padding: '16px',
        maxWidth: '1013px',
      }}
    >
      <Grid data={data}></Grid>
    </div>
  );
}
