import { plainToInstance, Transform, Type } from 'class-transformer';
import { IsArray, IsIn, IsInt, IsOptional, IsString, Min, ValidateNested } from 'class-validator';

// Column names are interpolated into SQL, so only known columns are accepted.
const ALLOWED_COLUMNS = ['id', 'subject', 'status', 'priority', 'assignee', 'createdAt'] as const;

// The conditions the grid offers for these columns: the text list for the text
// and dropdown columns, and the date list for createdAt (type: 'date'). The
// service handles each one, and any other name returns 400 instead of an
// unfiltered result.
export const FILTER_CONDITIONS = [
  'empty', 'not_empty', 'eq', 'neq', 'begins_with', 'ends_with', 'contains', 'not_contains',
  'date_before', 'date_before_or_equal', 'date_after', 'date_after_or_equal', 'between',
  'date_today', 'date_tomorrow', 'date_yesterday',
] as const;
export type FilterCondition = (typeof FILTER_CONDITIONS)[number];

export class FilterConditionDto {
  @IsIn(ALLOWED_COLUMNS)
  prop: string;

  @IsIn(FILTER_CONDITIONS)
  condition: FilterCondition;

  // Absent for conditions that take no argument, such as 'empty'.
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  value: string[] = [];
}

export class SortDto {
  @IsIn(ALLOWED_COLUMNS)
  column: string;

  @IsIn(['asc', 'desc'])
  order: 'asc' | 'desc';
}

export class FetchTicketsDto {
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page: number = 1;

  @IsInt()
  @Min(1)
  @Type(() => Number)
  pageSize: number = 10;

  @IsOptional()
  @ValidateNested()
  @Type(() => SortDto)
  sort?: SortDto;

  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => FilterConditionDto)
  @Transform(({ value }) => {
    const arr = Array.isArray(value) ? value : value ? [value] : [];
    return arr.map((item) => plainToInstance(FilterConditionDto, item));
  })
  filters?: FilterConditionDto[];
}
