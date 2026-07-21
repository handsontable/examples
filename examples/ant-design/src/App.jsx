import React, { useCallback, useEffect, useState } from 'react';
import { Card, Space, Tag, Typography } from 'antd';
import { HotTable, HotColumn } from '@handsontable/react-wrapper';
import { registerAllModules } from 'handsontable/registry';
import { buildHotThemeProps } from './hotTheme';

registerAllModules();

const data = [
  {
    key: '1',
    name: 'John Brown',
    age: 32,
    address: 'New York No. 1 Lake Park',
    tags: ['nice', 'developer'],
    actionHint: null,
  },
  {
    key: '2',
    name: 'Jim Green',
    age: 42,
    address: 'London No. 1 Lake Park',
    tags: ['loser'],
    actionHint: null,
  },
  {
    key: '3',
    name: 'Joe Black',
    age: 32,
    address: 'Sydney No. 1 Lake Park',
    tags: ['cool', 'teacher'],
    actionHint: null,
  },
];

function NameCell({ value }) {
  const label = value != null ? String(value) : '';
  return (
    <Typography.Link href="#" onClick={(e) => e.preventDefault()}>
      {label}
    </Typography.Link>
  );
}

function TagsCell({ value }) {
  const tags = Array.isArray(value) ? value : [];
  if (tags.length === 0) {
    return null;
  }
  return (
    <Space size={4} wrap>
      {tags.map((tag) => {
        let color = tag.length > 5 ? 'geekblue' : 'green';
        if (tag === 'loser') {
          color = 'volcano';
        }
        return (
          <Tag key={tag} color={color}>
            {String(tag).toUpperCase()}
          </Tag>
        );
      })}
    </Space>
  );
}

function ActionCell({ instance, row }) {
  const rowData = instance.getSourceDataAtRow(row);
  return (
    <Space size="middle">
      <Typography.Link href="#" onClick={(e) => e.preventDefault()}>
        Invite {rowData?.name ?? ''}
      </Typography.Link>
      <Typography.Link href="#" onClick={(e) => e.preventDefault()}>
        Delete
      </Typography.Link>
    </Space>
  );
}

function AntLikeGrid() {
  const readOnlyCell = useCallback(() => ({ readOnly: true }), []);
  const [themeProps, setThemeProps] = useState(null);

  useEffect(() => {
    let cancelled = false;
    buildHotThemeProps().then((props) => {
      if (!cancelled) setThemeProps(props);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!themeProps) {
    return null;
  }

  return (
    <HotTable
      {...themeProps}
      data={data}
      colHeaders={['Name', 'Age', 'Address', 'Tags', 'Action']}
      rowHeaders={false}
      stretchH="all"
      height="auto"
      autoRowSize={false}
      autoColumnSize={false}
      licenseKey="non-commercial-and-evaluation"
      cells={readOnlyCell}
    >
      <HotColumn data="name" width={160} renderer={NameCell} />
      <HotColumn data="age" width={72} type="numeric" />
      <HotColumn data="address" width={280} />
      <HotColumn data="tags" width={240} renderer={TagsCell} />
      <HotColumn data="actionHint" width={220} renderer={ActionCell} />
    </HotTable>
  );
}

export default function App() {
  return (
    <div style={{ padding: 24, background: '#f5f5f5', minHeight: '100vh' }}>
      <Card title={<Typography.Text strong>Handsontable with Ant Design theme tokens</Typography.Text>}>
        <AntLikeGrid />
      </Card>
    </div>
  );
}
