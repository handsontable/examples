import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import FluentHotTable from './components/FluentHotTable';

export default function App() {
  return (
    <FluentProvider theme={webLightTheme}>
      <FluentHotTable />
    </FluentProvider>
  );
}
