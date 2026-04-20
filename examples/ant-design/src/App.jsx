import React, { useCallback } from 'react';
import { Card, Space, Tag, Typography } from 'antd';
import { HotTable, HotColumn } from '@handsontable/react-wrapper';
import { registerAllModules } from 'handsontable/registry';
import { getTheme, hasTheme, horizonTheme, registerTheme } from 'handsontable/themes';
import colorsAnt from 'handsontable/themes/static/variables/colors/ant';

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

const THEME_NAME = 'horizon-ant-table';

const antTableTheme = (() => {
  if (hasTheme(THEME_NAME)) {
    return getTheme(THEME_NAME);
  }
  return registerTheme(THEME_NAME, horizonTheme)
    .params({
      colors: colorsAnt,
      tokens: {
        wrapperBorderColor: ['colors.palette.200', 'colors.palette.700'],
        wrapperBorderRadius: '8px',
        headerBackgroundColor: ['colors.palette.100', 'colors.palette.800'],
        headerFontWeight: '600',
        cellHorizontalBorderColor: ['colors.palette.200', 'colors.palette.700'],
        cellVerticalBorderColor: ['colors.palette.200', 'colors.palette.700'],
        cellHorizontalPadding: '16px',
        cellVerticalPadding: '8px',
        rowCellEvenBackgroundColor: ['colors.white', 'colors.palette.950'],
        rowCellOddBackgroundColor: ['colors.white', 'colors.palette.950'],
        cellReadOnlyBackgroundColor: ['colors.white', 'colors.palette.950'],
        foregroundColor: ['colors.palette.800', 'colors.palette.100'],
        linkColor: ['colors.primary.200', 'colors.primary.100'],
        linkHoverColor: ['colors.primary.100', 'colors.primary.200'],
      },
    })
    .setColorScheme('light')
    .setDensityType('comfortable');
})();

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

  return (
    <HotTable
      theme={antTableTheme}
      data={data}
      colHeaders={['Name', 'Age', 'Address', 'Tags', 'Action']}
      rowHeaders={false}
      stretchH="all"
      height="auto"
      autoRowSize={false}
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
