import { plainToInstance, Transform, Type } from 'class-transformer';
import { IsArray, IsIn, IsInt, IsOptional, IsString, Min, ValidateNested } from 'class-validator';

// Column names are interpolated into SQL, so only known columns are accepted.
// Condition names are not whitelisted: the service skips names it doesn't handle.
const ALLOWED_COLUMNS = ['id', 'subject', 'status', 'priority', 'assignee', 'createdAt'] as const;

export class FilterConditionDto {
  @IsIn(ALLOWED_COLUMNS)
  prop: string;

  @IsString()
  condition: string;

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
